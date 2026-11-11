// Run through browser-ci.cjs, which bundles the real RTC module with fixture signalling.
// All account, room, and task requests use an in-browser fixture.
async (page) => {
    const origin = new URL(page.url()).origin;
    const failures = [];
    page.on('pageerror', error => failures.push(error.message));
    const assert = (condition, message) => { if (!condition) throw new Error(message); };
    const visible = async selector => {
        await page.locator(selector).waitFor({ state: 'visible' });
        if (selector === '#join-modal') await page.waitForFunction(() => !document.getElementById('join-btn').disabled);
    };
    // Polls briefly: right after a resize, size transitions hold the old layout for a frame.
    const fitsViewport = () => page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth, undefined, { timeout: 2000 }).catch(() => { throw new Error('Page overflows horizontally at ' + page.viewportSize().width + 'px'); });
    await page.emulateMedia({ reducedMotion: 'reduce' });

    await page.route('https://open.spotify.com/**', route => route.fulfill({ body: '<body>Spotify player fixture</body>', contentType: 'text/html' }));
    await page.route('https://www.youtube.com/**', route => route.fulfill({ body: '<body style="background:#14221b;color:#9baa9c;font:12px sans-serif;padding:20px">Background audio preview</body>', contentType: 'text/html' }));
    await page.addInitScript({ path: 'scripts/supabase-fixture.js' });
    await page.addInitScript(() => {
        if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => { throw new Error('Camera disabled for UI test'); };
    });
    await page.goto(origin + '/login.html');
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.reload();

    // Landing page: fits every width, the hero timer responds, and old invite links still reach the room.
    await page.goto(origin + '/');
    for (const width of [1440, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await fitsViewport();
        await visible('#preview-toggle');
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    assert(await page.locator('.intro').isHidden(), 'Reduced motion must skip the opening animation');
    await page.screenshot({ path: 'output/playwright/landing-desktop.png' });
    await page.getByRole('button', { name: 'Play the demo', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('preview-time').textContent !== '25:00' && Number(getComputedStyle(document.body).getPropertyValue('--sun-y')) > .43);
    await page.getByRole('button', { name: 'Daylight', exact: true }).click();
    assert(await page.locator('html').getAttribute('data-theme') === 'daylight', 'Landing swatches should change the atmosphere');
    await page.getByRole('button', { name: 'Forest', exact: true }).click();
    assert(await page.getByRole('link', { name: 'Log in', exact: true }).first().getAttribute('href') === '/login.html', 'Signed-out visitors are sent to login');

    // Setup flow: every answer changes the page, is kept for the room, and ends in an account.
    await page.goto(origin + '/start.html');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    assert(await page.locator('#start-message').isVisible() && await page.locator('.step[data-step="name"]').isVisible(), 'Setup needs a name before moving on');
    await page.getByLabel('Your name').fill('Alex');
    assert(await page.locator('#start-greeting').innerText() === 'Hello, Alex.', 'The greeting should answer as the name is typed');
    await page.getByLabel('Your name').press('Enter');
    await page.getByRole('button', { name: 'Midnight', exact: true }).click();
    assert(await page.locator('html').getAttribute('data-theme') === 'midnight', 'Choosing a sky should retheme the page');
    await page.getByRole('button', { name: 'Forest', exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    const sunAt = () => page.evaluate(() => Number(document.body.style.getPropertyValue('--sun-y')));
    const lowSun = await sunAt();
    await page.getByRole('button', { name: '45 min', exact: true }).click();
    assert(await page.locator('#start-minutes').innerText() === '45' && await sunAt() < lowSun, 'A longer block should lift the sun');
    const sunBox = await page.locator('.sun').boundingBox();
    await page.mouse.move(sunBox.x + sunBox.width / 2, sunBox.y + sunBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(sunBox.x + sunBox.width / 2, sunBox.y - 60, { steps: 4 });
    await page.mouse.up();
    assert(Number(await page.locator('#start-minutes').innerText()) > 45, 'Dragging the sun up should lengthen the block');
    await page.getByLabel('Focus length in minutes').fill('30');
    for (const width of [1440, 390, 320]) { await page.setViewportSize({ width, height: 900 }); await fitsViewport(); }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: 'output/playwright/setup-desktop.png' });
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await visible('.step[data-step="sky"]');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: /^Ocean/ }).click();
    await page.getByRole('button', { name: /^Silence/ }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Create my account', exact: true }).click();
    assert((await page.locator('#start-message').innerText()).includes('email') && await page.evaluate(() => window.__fixture.calls.length) === 0, 'Setup must validate before reaching auth');
    await page.getByLabel('Email address').fill('alex@example.com');
    await page.getByLabel('Password', { exact: true }).fill('test-password');
    await page.getByRole('button', { name: 'Create my account', exact: true }).click();
    await page.waitForURL(origin + '/room.html');
    await visible('#join-modal');
    assert(await page.locator('#lobby-step').isVisible(), 'A name given during setup must not be asked for again');
    assert(await page.evaluate(() => localStorage.getItem('flow_focus_minutes')) === '30', 'Setup choices should be kept for the room');
    // A room created after setup starts with the chosen focus length and shows the first-session checklist.
    await page.getByRole('button', { name: 'Create a room', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('time-display').textContent === '30:00');
    await visible('#room-guidance');
    await page.getByRole('button', { name: 'Start timer', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-check="timer"]').classList.contains('done'));
    await page.getByRole('button', { name: 'Leave', exact: true }).click();
    await page.getByRole('button', { name: 'Leave room', exact: true }).click();
    await visible('#join-modal');
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });

    await page.goto(origin + '/?room=FOCUS6');
    await page.waitForURL(origin + '/login.html?room=FOCUS6');
    assert((await page.locator('#invite-note').innerText()).includes('FOCUS6'), 'An invite code should survive the trip through login');
    await page.goto(origin + '/login.html');
    for (const width of [1440, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await fitsViewport();
        await visible('#login-btn');
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: 'output/playwright/after-login-desktop.png' });
    await page.getByRole('button', { name: 'Show password', exact: true }).click();
    assert(await page.locator('#password-input').getAttribute('type') === 'text', 'Password visibility should toggle');
    await page.getByRole('button', { name: 'Hide password', exact: true }).click();
    await page.getByLabel('Your atmosphere').selectOption('midnight');
    await page.reload();
    assert(await page.locator('html').getAttribute('data-theme') === 'midnight', 'Theme should persist');
    await page.getByLabel('Your atmosphere').selectOption('forest');
    await page.getByLabel('Email address').fill('invalid');
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    assert(await page.evaluate(() => window.__fixture.calls.length) === 0, 'Invalid email must not reach auth');
    await page.getByLabel('Email address').fill('alex@example.com');
    await page.getByLabel('Password', { exact: true }).fill('test-password');
    await page.evaluate(() => { window.__fixture.authFailure = true; });
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    await page.locator('#error-message').waitFor({ state: 'visible' });
    assert(!(await page.locator('#login-btn').isDisabled()), 'Login must recover after network failure');
    await page.evaluate(() => { window.__fixture.authFailure = false; window.__fixture.delay = 150; });
    await page.getByLabel('Password', { exact: true }).press('Enter');
    await page.waitForURL(origin + '/room.html');
    await visible('#join-modal');
    await page.screenshot({ path: 'output/playwright/after-lobby-desktop.png' });
    await page.getByRole('button', { name: 'Join room', exact: true }).click();
    await visible('#lobby-error');
    assert(await page.evaluate(() => window.__fixture.calls.filter(call => call.action === 'rpc').length) === 0, 'Invalid room code must not call the backend');
    await page.getByLabel('Room code', { exact: true }).fill('FOCUS6');
    await page.evaluate(() => { window.__fixture.rpcError = 'Incorrect PIN'; });
    await page.getByRole('button', { name: 'Join room', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('join-btn').disabled);
    assert((await page.locator('#lobby-error').innerText()).includes('PIN'), 'Wrong PIN should show an inline error');
    await page.evaluate(() => { window.__fixture.rpcError = 'throw'; });
    await page.getByRole('button', { name: 'Join room', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('join-btn').disabled);
    assert(await page.locator('#app').isHidden(), 'Failed join must stay in the lobby');
    await page.evaluate(() => { window.__fixture.rpcError = null; });

    await page.getByRole('button', { name: 'Join room', exact: true }).click();
    await page.locator('#new-task-input').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.getElementById('new-task-input').disabled);
    assert(await page.locator('#toggle-cam').getAttribute('aria-pressed') === 'false', 'Unavailable camera should display its off state');
    await page.locator('.reactions-menu summary').click();
    for (const name of ['Thumbs up', 'Heart', 'Laugh', 'Celebrate']) await page.getByRole('button', { name, exact: true }).click();
    await page.getByRole('button', { name: 'Raise hand', exact: true }).click();
    await visible('.hand-raised-badge');
    await page.getByRole('button', { name: 'Raise hand', exact: true }).click();
    await page.locator('.reactions-menu summary').click();
    await page.getByRole('button', { name: 'Toggle microphone', exact: true }).click();
    assert(await page.locator('#toggle-mic').getAttribute('aria-pressed') === 'false', 'Mic should toggle off');
    await page.getByRole('button', { name: 'Toggle microphone', exact: true }).click();
    await page.getByRole('button', { name: 'Toggle camera', exact: true }).click();
    await page.getByLabel('New shared task').fill('Review chapter 4');
    await page.getByRole('button', { name: 'Add task', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.task-checkbox') && !document.querySelector('.task-checkbox').disabled);
    await page.getByRole('button', { name: 'Complete task: Review chapter 4', exact: true }).focus();
    await page.keyboard.press('Space');
    assert(await page.locator('#room-task-progress-text').innerText() === '100%', 'Keyboard task completion should update progress');
    await page.getByRole('button', { name: 'Mark incomplete: Review chapter 4', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('room-task-progress-fill').getBoundingClientRect().width < 1);
    await page.locator('.stage-header h1').click();
    await page.screenshot({ path: 'output/playwright/after-room-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'output/playwright/after-room-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: 'Leave', exact: true }).click();
    await page.screenshot({ path: 'output/playwright/after-leave-desktop.png' });
    await page.getByRole('button', { name: 'Stay in room', exact: true }).click();
    await page.locator('.task-assignee-select').selectOption('test-user');
    await page.waitForFunction(() => document.querySelector('.task-item')?.getAttribute('aria-busy') === 'false');
    assert(await page.evaluate(() => window.__fixture.tables.tasks[0].assigned_to) === 'test-user', 'Task assignment should persist');

    await page.getByRole('button', { name: 'Start timer', exact: true }).click();
    await visible('[aria-label="Pause timer"]');
    await page.getByRole('button', { name: 'Pause timer', exact: true }).click();
    await page.getByRole('button', { name: 'Break', exact: true }).click();
    assert(await page.locator('#time-display').innerText() === '05:00', 'Break should show five minutes');
    await page.getByRole('button', { name: 'Long break', exact: true }).click();
    assert(await page.locator('#time-display').innerText() === '15:00', 'Long break should show fifteen minutes');
    await page.getByRole('button', { name: 'Reset timer', exact: true }).click();
    await page.getByRole('button', { name: 'Focus', exact: true }).click();
    await page.getByRole('button', { name: 'Toggle Focus Mode', exact: true }).click();
    await visible('#timer-toggle-btn');
    await visible('#focus-mode-toggle');
    await page.getByRole('button', { name: 'Toggle Focus Mode', exact: true }).click();
    await page.getByRole('button', { name: 'Timer settings', exact: true }).click();
    await page.getByLabel('Focus (minutes)', { exact: true }).fill('30');
    await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
    assert(await page.locator('#time-display').innerText() === '30:00', 'Timer settings should apply');
    // Shortcuts act on the room but never while a control has focus or a dialog is open.
    await page.locator('.stage-header h1').click();
    await page.keyboard.press('s');
    await visible('[aria-label="Pause timer"]');
    await page.keyboard.press('s');
    await visible('[aria-label="Start timer"]');
    await page.keyboard.press('?');
    await visible('#shortcuts-modal');
    await page.keyboard.press('s');
    assert(await page.locator('#timer-toggle-btn').getAttribute('aria-pressed') === 'false', 'Shortcuts must pause while a dialog is open');
    await page.keyboard.press('Escape');
    await page.getByLabel('New shared task').fill('s');
    assert(await page.locator('#timer-toggle-btn').getAttribute('aria-pressed') === 'false', 'Typing must not trigger shortcuts');
    await page.getByLabel('New shared task').fill('');

    // Soundscape buttons are exclusive toggles and generate audio locally.
    await page.getByRole('tab', { name: 'Sound', exact: true }).click();
    for (const name of ['Rain', 'Ocean', 'Fireplace', 'Wind', 'Night', 'Deep hum']) await page.getByRole('button', { name, exact: true }).click();
    await page.getByRole('button', { name: 'Rain', exact: true }).click();
    await page.getByRole('button', { name: 'Ocean', exact: true }).click();
    assert(await page.getByRole('button', { name: 'Rain', exact: true }).getAttribute('aria-pressed') === 'false' && await page.getByRole('button', { name: 'Ocean', exact: true }).getAttribute('aria-pressed') === 'true', 'Only one soundscape plays at a time');
    await page.getByRole('button', { name: 'Ocean', exact: true }).click();
    assert(await page.getByRole('button', { name: 'Ocean', exact: true }).getAttribute('aria-pressed') === 'false', 'Clicking the active soundscape stops it');
    await page.getByRole('tab', { name: 'Tasks', exact: true }).click();

    await page.getByRole('tab', { name: 'Tasks', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    assert(await page.getByRole('tab', { name: 'Chat', exact: true }).getAttribute('aria-selected') === 'true', 'Arrow key should activate Chat');
    await page.getByLabel('Message to room').fill('Ready for the next session.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    assert((await page.locator('#chat-messages').innerText()).includes('Ready for the next session.'), 'Chat should render messages');
    await page.getByRole('tab', { name: 'Tasks', exact: true }).click();
    await page.getByRole('button', { name: 'Edit your profile', exact: true }).focus();
    await page.keyboard.press('Enter');
    await visible('#profile-modal');
    await page.getByRole('button', { name: 'Close profile', exact: true }).click();
    // Dialogs trap focus and restore it on Escape.
    await page.getByRole('button', { name: 'Timer settings', exact: true }).click();
    await page.getByLabel('Focus (minutes)', { exact: true }).fill('999');
    await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
    await visible('#timer-settings-modal');
    assert(await page.locator('#time-display').innerText() === '30:00', 'Invalid durations must not be saved');
    await page.getByRole('button', { name: 'Save Changes', exact: true }).focus();
    await page.keyboard.press('Tab');
    assert(await page.evaluate(() => document.activeElement.id) === 'close-timer-settings-btn', 'Tab should wrap within the dialog');
    await page.keyboard.press('Escape');
    assert(await page.evaluate(() => document.activeElement.id) === 'open-timer-settings-btn', 'Dialog should restore focus');

    // Clipboard denial falls back to a selectable invite link.
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Denied'); } } }));
    await page.getByRole('button', { name: 'Invite', exact: true }).click();
    await visible('#invite-modal');
    assert((await page.locator('#invite-link-input').inputValue()).includes('room=FOCUS6'), 'Fallback invite should include room code');
    await page.getByRole('button', { name: 'Done', exact: true }).click();

    // All appearance themes maintain readable body text.
    for (const theme of ['forest', 'midnight', 'warm', 'aqua', 'amethyst', 'desert', 'aurora', 'storm', 'dawn', 'daylight']) {
        await page.getByLabel('Room atmosphere').selectOption(theme);
        const contrast = await page.evaluate(() => {
            const style = getComputedStyle(document.body);
            const luminance = color => {
                const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
                return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
            };
            const a = luminance(style.color), b = luminance(style.backgroundColor);
            return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
        });
        assert(contrast >= 4.5, theme + ' body text contrast');
    }
    await page.getByLabel('Room atmosphere').selectOption('forest');

    // Rejected and empty-row writes roll back without erasing input.
    await page.evaluate(() => { window.__fixture.fail = { table: 'tasks', action: 'insert', throw: true }; });
    await page.getByLabel('New shared task').fill('Keep this draft');
    await page.getByRole('button', { name: 'Add task', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('add-task-btn').disabled);
    assert(await page.getByLabel('New shared task').inputValue() === 'Keep this draft', 'Failed insert must preserve text');
    assert(await page.locator('.task-item').count() === 1, 'Failed insert must remove its optimistic row');
    await page.evaluate(() => { window.__fixture.fail = { table: 'tasks', action: 'update', zero: true }; });
    await page.getByRole('button', { name: 'Complete task: Review chapter 4', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.task-item')?.getAttribute('aria-busy') === 'false');
    assert(await page.locator('#room-task-progress-text').innerText() === '0%', 'Denied update must restore previous state');
    await page.evaluate(() => { window.__fixture.fail = { table: 'tasks', action: 'delete', throw: true }; });
    await page.getByRole('button', { name: 'Delete Task', exact: true }).click();
    await page.getByRole('button', { name: 'Delete Task', exact: true }).waitFor();
    assert(await page.locator('.task-item').count() === 1, 'Failed delete must restore its task');

    // Failed initial task reads offer a working retry.
    await page.evaluate(async () => {
        window.__fixture.fail = { table: 'tasks', action: 'select', throw: true };
        await window.__fixture.handlers['postgres_changes:*']();
    });
    await visible('#retry-tasks-btn');
    await page.getByRole('button', { name: 'Retry loading tasks', exact: true }).click();
    await page.locator('#retry-tasks-btn').waitFor({ state: 'hidden' });

    // A click burst while saving creates one task.
    await page.getByLabel('New shared task').fill('One request only');
    await page.evaluate(() => {
        window.__fixture.delay = 250;
        for (let i = 0; i < 20; i++) document.getElementById('new-task-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await page.waitForFunction(() => !document.getElementById('add-task-btn').disabled);
    assert(await page.locator('.task-item').count() === 2, 'Repeated Enter must not duplicate an in-flight insert');
    await page.evaluate(() => { window.__fixture.delay = 0; });

    // Profile failures recover, and markup is rendered as text.
    await page.getByRole('button', { name: 'Edit your profile', exact: true }).click();
    await page.getByLabel('Display name', { exact: true }).fill('<img src=x onerror=alert(1)>');
    await page.getByRole('button', { name: 'Save Name', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('save-profile-name-btn').disabled);
    assert(await page.locator('#my-username img').count() === 0, 'Display names must not create HTML');
    await page.evaluate(() => { window.__fixture.fail = { table: 'profiles', action: 'insert', throw: true }; });
    await page.getByRole('button', { name: 'Save Name', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('save-profile-name-btn').disabled);
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Edit your profile', exact: true }).click();
    await page.getByLabel('Display name', { exact: true }).fill('Alex');
    await page.getByRole('button', { name: 'Save Name', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('save-profile-name-btn').disabled);
    await page.keyboard.press('Escape');

    // Background media accepts actual YouTube hosts, not lookalike domains.
    await page.getByRole('tab', { name: 'Sound', exact: true }).click();
    await page.getByLabel('YouTube video or playlist link').fill('https://youtube.com.attacker.example/watch?v=jfKfPfyJRdk');
    const previousSrc = await page.locator('#youtube-iframe').getAttribute('src');
    assert(previousSrc === null, 'No third-party player should load before someone asks for one');
    await page.getByRole('button', { name: 'Share audio with room', exact: true }).click();
    assert(await page.locator('#youtube-iframe').getAttribute('src') === previousSrc, 'Invalid media URL must not load');
    await page.getByLabel('YouTube video or playlist link').fill('https://youtu.be/jfKfPfyJRdk');
    await page.getByRole('button', { name: 'Share audio with room', exact: true }).click();

    await page.getByRole('button', { name: 'Spotify', exact: true }).click();
    await visible('#spotify-empty');
    assert(await page.locator('#youtube-iframe').getAttribute('src') === 'about:blank', 'Switching provider must unload the previous player');
    const spotifyInput = page.getByLabel('Spotify track, album, or playlist link');
    await spotifyInput.fill('https://open.spotify.com.attacker.example/track/4uLU6hMCjMI75M1A2tKUQC');
    await page.getByRole('button', { name: 'Share audio with room', exact: true }).click();
    await visible('#spotify-empty');
    await spotifyInput.fill('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=test');
    await page.getByRole('button', { name: 'Share audio with room', exact: true }).click();
    await visible('#spotify-iframe');
    assert(await page.locator('#spotify-iframe').getAttribute('src') === 'https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC?theme=0', 'Spotify should use the canonical official embed');
    await page.evaluate(() => window.__fixture.handlers['broadcast:audio-sync']({ payload: { provider: 'spotify', url: 'https://open.spotify.com/album/4uLU6hMCjMI75M1A2tKUQC' } }));
    assert((await page.locator('#spotify-iframe').getAttribute('src')).includes('/album/'), 'Incoming room audio should update the player');
    await page.getByRole('button', { name: 'YouTube', exact: true }).click();
    assert(await page.locator('#spotify-iframe').getAttribute('src') === 'about:blank', 'Returning to YouTube must stop Spotify');

    // Local backend failures show retry feedback without losing the question.
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
    await page.route('**/api/ai', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"text":"Unavailable"}' }));
    await page.getByLabel('Message to room').fill('/ai Explain gravity');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.locator('#ai-pending').waitFor({ state: 'hidden' });
    assert(await page.getByLabel('Message to room').inputValue() === '/ai Explain gravity', 'Failed AI request should preserve question');
    await page.unroute('**/api/ai');
    await page.route('**/api/ai', route => route.fulfill({ contentType: 'application/json', body: '{"text":"Gravity attracts masses."}' }));
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('chat-messages').textContent.includes('Gravity attracts masses.'));
    await page.evaluate(() => { window.__fixture.sendStatus = 'timed out'; });
    await page.getByLabel('Message to room').fill('Retry this message');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('chat-input').value === 'Retry this message');
    await page.evaluate(() => { window.__fixture.sendStatus = 'ok'; });

    // 1,000 incoming messages stay bounded and hostile markup stays inert.
    await page.evaluate(async () => {
        const chat = { handleIncomingMessage: payload => window.__fixture.handlers['broadcast:chat-message']({ payload }) };
        for (let i = 0; i < 1000; i++) chat.handleIncomingMessage({ sender: '<svg onload=alert(1)>', text: '<img src=x onerror=alert(1)> ' + i + 'x'.repeat(500) });
        chat.handleIncomingMessage(null);
    });
    assert(await page.locator('#chat-messages > div').count() === 300, 'Chat history must stay bounded');
    assert(await page.locator('#chat-messages img, #chat-messages svg').count() === 0, 'Chat markup must stay inert');
    await page.getByRole('tab', { name: 'Tasks', exact: true }).click();

    // A dense task list stays usable after repeated reconciliation.
    const taskTiming = await page.evaluate(async () => {
        window.__fixture.savedTasks = structuredClone(window.__fixture.tables.tasks);
        window.__fixture.tables.tasks = Array.from({ length: 500 }, (_, i) => ({
            id: 'stress-' + i, room_id: 'test-room', created_by: 'test-user',
            title: '<img src=x> Task ' + i + 'x'.repeat(70), completed: i % 2 === 0
        }));
        const start = performance.now();
        for (let i = 0; i < 5; i++) await window.__fixture.handlers['postgres_changes:*']();
        return Math.round(performance.now() - start);
    });
    assert(await page.locator('.task-item').count() === 500, 'Task stress rows must not duplicate');
    assert(await page.locator('.task-item img').count() === 0, 'Task titles must stay inert');
    console.log('500 task rows, 5 reconciliations: ' + taskTiming + 'ms');
    await page.evaluate(async () => { window.__fixture.tables.tasks = window.__fixture.savedTasks; await window.__fixture.handlers['postgres_changes:*'](); });


    // Actual local WebRTC negotiation with synthetic media and host-only ICE.
    // Supabase signalling and provider endpoints remain mocked.
    await page.route('**/api/turn-credentials', () => {}); // Deliberately stalled: the client must time out and continue.
    const rtcResult = await page.evaluate(async () => {
        const rtc = await import('/__flow-test/rtc.js');
        const probeVideo = document.createElement('video');
        await rtc.initMedia(probeVideo);
        const NativePeer = window.RTCPeerConnection;
        window.RTCPeerConnection = class extends NativePeer { constructor() { super({ iceServers: [] }); } };
        let remote;
        let local;
        try {
            const turnStart = performance.now();
            await rtc.callUser('outbound-test', () => {});
            const turnFallbackMs = performance.now() - turnStart;
            const offered = window.__fixture.calls.some(call => call.value?.payload?.to === 'outbound-test' && call.value?.payload?.signal?.type === 'offer');
            rtc.removePeer('outbound-test');
            remote = new NativePeer({ iceServers: [] });
            const received = [];
            remote.ontrack = event => received.push(event.track);
            local = await rtc.getOrCreatePeerConnection('loopback-test', () => {});
            const queued = [];
            local.addEventListener('icecandidate', event => {
                if (!event.candidate) return;
                if (remote.remoteDescription) remote.addIceCandidate(event.candidate).catch(() => {});
                else queued.push(event.candidate);
            });
            remote.onicecandidate = event => {
                if (event.candidate) rtc.handleSignal({ from: 'loopback-test', signal: { type: 'candidate', candidate: event.candidate.toJSON() } }, () => {});
            };
            remote.addTransceiver('video', { direction: 'recvonly' });
            remote.addTransceiver('audio', { direction: 'recvonly' });
            const offer = await remote.createOffer();
            await remote.setLocalDescription(offer);
            await rtc.handleSignal({ from: 'loopback-test', signal: { type: 'offer', offer: { type: offer.type, sdp: offer.sdp } } }, () => {});
            const answer = window.__fixture.calls.filter(call => call.value?.payload?.to === 'loopback-test' && call.value?.payload?.signal?.type === 'answer').at(-1)?.value.payload.signal.answer;
            if (!answer) throw new Error('No WebRTC answer');
            await remote.setRemoteDescription(answer);
            for (const candidate of queued) await remote.addIceCandidate(candidate);
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Loopback WebRTC did not connect')), 8000);
                const check = () => { if (local.connectionState === 'connected') { clearTimeout(timeout); resolve(); } };
                local.addEventListener('connectionstatechange', check);
                check();
            });
            return { offered, connected: local.connectionState, tracks: received.length, needsCall: rtc.peerNeedsCall('loopback-test'), turnFallbackMs };
        } finally {
            remote?.close();
            rtc.removePeer('loopback-test');
            probeVideo.srcObject?.getTracks().forEach(track => track.stop());
            rtc.cleanupDummyStream();
            window.RTCPeerConnection = NativePeer;
        }
    });
    assert(rtcResult.offered && rtcResult.connected === 'connected' && rtcResult.tracks === 2 && !rtcResult.needsCall, 'Local WebRTC must negotiate and deliver audio/video tracks');
    assert(rtcResult.turnFallbackMs >= 4500 && rtcResult.turnFallbackMs < 10000, 'A stalled TURN provider must not block connection setup indefinitely');

    // 16 simulated participants exercise tile creation and name handling.
    await page.evaluate(() => {
        for (let i = 0; i < 16; i++) window.__fixture.handlers['presence:join']({ key: 'zz-test-' + i, newPresences: [{ username: '<img src=x> Partner ' + i, isDummyMedia: true }] });
    });
    assert(await page.locator('.video-wrapper').count() === 17, 'Participant joins must create one tile each');
    assert(await page.locator('#video-grid img').count() === 0, 'Participant names must stay inert');
    await page.context().setOffline(true);
    await visible('#network-banner');
    await page.context().setOffline(false);

    // Failed channel tracking retries and returns to a connected state.
    const channelCount = await page.evaluate(() => {
        window.__fixture.trackFailures = 1;
        const count = window.__fixture.channelCount;
        window.__fixture.status('CHANNEL_ERROR');
        return count;
    });
    await page.waitForFunction(previous => window.__fixture.channelCount >= previous + 2 && document.getElementById('connection-status').textContent === 'Connected', channelCount);

    // Presence leave/rejoin preserves the returning tile through the grace period.
    await page.clock.install();
    await page.evaluate(() => {
        for (let i = 0; i < 16; i++) window.__fixture.handlers['presence:leave']({ key: 'zz-test-' + i });
        window.__fixture.handlers['presence:join']({ key: 'zz-test-0', newPresences: [{ username: 'Returning partner', isDummyMedia: true }] });
    });
    assert(await page.locator('.video-wrapper.left .left-note').count() === 15 && await page.locator('#count').innerText() === '2', 'A departure should show on the tile and in the count at once');
    assert(await page.locator('#video-wrapper-zz-test-0.left').count() === 0, 'A returning partner must not be shown as gone');
    await page.clock.fastForward(18001);
    assert(await page.locator('.video-wrapper').count() === 2, 'Only genuinely departed participants should be removed');

    await page.getByRole('button', { name: 'Start timer', exact: true }).click();
    await page.clock.fastForward(61000);
    const elapsedTime = await page.locator('#time-display').innerText();
    assert(['28:59', '28:58'].includes(elapsedTime), 'Timer should follow elapsed wall time after throttled ticks');
    await page.getByRole('button', { name: 'Edit your profile', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('profile-today-value')?.textContent === '1m');
    assert((await page.locator('#my-focus-time').textContent()).includes('1m'), 'Card and open profile must agree on live focus');
    await page.clock.fastForward(60000);
    await page.waitForFunction(() => document.getElementById('profile-today-value')?.textContent === '2m');
    await page.screenshot({ path: 'output/playwright/profile-live-focus.png' });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Pause timer', exact: true }).click();
    await page.clock.fastForward(60000);
    assert((await page.locator('#my-focus-time').textContent()).includes('2m'), 'Paused time must not count as focus');
    await page.getByRole('button', { name: 'Reset timer', exact: true }).click();

    // Local timer rejects malformed peer state and completes without waiting 25 minutes.
    await page.evaluate(async () => {
        window.__fixture.handlers['broadcast:timer-updated']({ payload: { mode: 'unknown', timeLeft: -1, isRunning: true } });
    });
    assert(await page.locator('#time-display').innerText() === '30:00', 'Malformed peer state must be ignored');
    await page.evaluate(() => { window.__fixture.handlers['broadcast:timer-updated']({ payload: { mode: 'focus', timeLeft: 0, duration: 60, isRunning: true } }); });
    await visible('#timer-alert-modal');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    assert(await page.locator('#rounds i.done').count() === 1 && await page.locator('.mode-btn.active').innerText() === 'Break', 'A finished focus block should fill one round and move to a break');

    await page.waitForFunction(() => window.__fixture.tables.sessions.length === 1);
    await page.getByRole('button', { name: 'Edit your profile', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('profile-today-value')?.textContent === '2m');
    assert((await page.locator('#my-focus-time').textContent()).includes('2m'), 'Saved focus must replace live focus without double counting');
    await page.keyboard.press('Escape');

    // Leave supports cancellation and keeps the session active.
    await page.getByRole('button', { name: 'Leave', exact: true }).click();
    await visible('#leave-modal');
    await page.getByRole('button', { name: 'Stay in room', exact: true }).click();
    await visible('#app');

    for (const width of [1440, 1024, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await fitsViewport();
        await visible('#timer-toggle-btn');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'output/playwright/stress-room-mobile.png', fullPage: true });
    await page.getByRole('button', { name: 'Delete Task', exact: true }).first().click();
    await page.getByRole('button', { name: 'Delete Task', exact: true }).first().click();
    assert(await page.locator('.task-item').count() === 0, 'Delete should remove the task');
    await page.getByRole('button', { name: 'Leave', exact: true }).click();

    const cleanup = await page.evaluate(async () => {
        const tracks = document.getElementById('local-video').srcObject.getTracks();
        const freshRtc = await import('/__flow-test/rtc.js?cleanup-race');
        const pendingPeer = freshRtc.getOrCreatePeerConnection('cancelled-peer', () => {}).then(() => false, () => true);
        freshRtc.cleanupMedia();
        const cancelledPeer = await pendingPeer;
        const count = window.__fixture.channelCount;
        document.getElementById('confirm-leave-btn').click();
        window.__fixture.status('CLOSED');
        return { ended: tracks.every(track => track.readyState === 'ended'), disconnected: window.__fixture.untracked, noReconnect: count === window.__fixture.channelCount, cancelledPeer };
    });
    assert(cleanup.ended && cleanup.disconnected && cleanup.noReconnect && cleanup.cancelledPeer, 'Leaving must stop tracks and prevent channel resurrection');
    await visible('#join-modal');
    await fitsViewport();
    await page.screenshot({ path: 'output/playwright/after-lobby-mobile.png', fullPage: true });
    await page.waitForFunction(() => document.getElementById('room-code-input').value === 'FOCUS6' && document.getElementById('room-pin-input').value === '');
    await page.getByRole('button', { name: 'Join room', exact: true }).click();
    await visible('#app');
    await page.waitForFunction(() => !document.getElementById('new-task-input').disabled);
    assert(await page.locator('.video-wrapper').count() === 1, 'Rejoining should start with fresh participant tiles');
    await page.getByRole('button', { name: 'Leave', exact: true }).click();
    await page.getByRole('button', { name: 'Leave room', exact: true }).click();
    await visible('#join-modal');
    await page.evaluate(() => { window.__fixture.collision = true; });
    await page.getByRole('button', { name: 'Create a room', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('host-btn').disabled);
    assert(await page.evaluate(() => window.__fixture.calls.filter(call => call.table === 'rooms' && call.action === 'select').length) === 5, 'Room code collisions must stop after five attempts');
    await page.evaluate(() => { window.__fixture.collision = false; });
    await page.getByRole('button', { name: 'Create a room', exact: true }).click();
    await visible('#app');

    // Study-groups board: hosting opens a listed room, and a seat on the board leads straight into the room.
    await page.goto(origin + '/groups.html');
    await visible('.group-empty');
    for (const width of [1440, 390, 320]) { await page.setViewportSize({ width, height: 900 }); await fitsViewport(); }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: 'Open a room', exact: true }).click();
    assert(new URL(page.url()).pathname === '/groups.html', 'Hosting needs a topic');
    await page.getByLabel('What are you studying?').fill('<b>Linear algebra</b> problem set');
    await page.getByRole('button', { name: 'Open a room', exact: true }).click();
    await page.waitForURL(url => url.pathname === '/room.html');
    await page.waitForFunction(() => window.__fixture.tables.open_rooms.length === 1 && !document.getElementById('new-task-input').disabled);
    assert(await page.evaluate(() => { const row = window.__fixture.tables.open_rooms[0]; return row.seats === 4 && row.seats_taken === 1 && row.host_id === 'test-user'; }), 'A hosted room should be listed with its seats');
    await page.getByRole('button', { name: 'Invite', exact: true }).click();
    await visible('#board-unlist-btn');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('button', { name: 'Leave', exact: true }).click();
    await page.getByRole('button', { name: 'Leave room', exact: true }).click();
    await visible('#join-modal');
    assert(await page.evaluate(() => window.__fixture.tables.open_rooms.length) === 0, 'Leaving takes the room off the board');
    await page.goto(origin + '/groups.html?board');
    await page.locator('.group').first().waitFor();
    await page.screenshot({ path: 'output/playwright/groups-desktop.png' });
    assert(await page.getByRole('button', { name: 'Full', exact: true }).isDisabled(), 'A full group cannot be joined');
    assert(await page.locator('.group b, .group img').count() === 0, 'Group topics must stay inert');
    await page.getByRole('button', { name: 'Take a seat', exact: true }).click();
    await page.waitForURL(url => url.pathname === '/room.html' && url.searchParams.get('room') === 'FOCUS6');
    await visible('#app');
    await page.goto(origin + '/docs.html');
    for (const width of [1440, 390, 320]) { await page.setViewportSize({ width, height: 900 }); await fitsViewport(); }
    await page.setViewportSize({ width: 1440, height: 1000 });

    await page.evaluate(() => localStorage.removeItem('flow_user'));
    await page.goto(origin + '/login.html');
    await page.screenshot({ path: 'output/playwright/after-login-mobile.png', fullPage: true });

    await page.getByLabel('Email address').fill('alex@example.com');
    await page.getByLabel('Password', { exact: true }).fill('test-password');
    await page.getByRole('button', { name: 'Create an account', exact: true }).click();
    await page.waitForURL(origin + '/room.html');
    await visible('#join-modal');
    await page.getByRole('link', { name: 'Log out', exact: true }).click();
    await page.waitForURL(origin + '/login.html');
    assert(await page.evaluate(() => localStorage.getItem('flow_user')) === null, 'Logout must clear login');
    await page.evaluate(() => localStorage.setItem('flow_user', '{malformed'));
    await page.goto(origin + '/room.html');
    await page.waitForURL(origin + '/login.html');
    assert(failures.length === 0, 'Uncaught browser errors: ' + failures.join('; '));
    return { passed: true, taskRows: 500, reconciliations: 5, taskRenderMs: taskTiming, incomingMessages: 1000, retainedMessages: 300, simulatedParticipants: 16, localWebRTC: rtcResult, cleanup, browserErrors: failures };

}

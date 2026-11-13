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
    // Trusted Types: a raw HTML string is refused by the browser itself, so a missed escape cannot become script.
    assert(await page.evaluate(() => { try { document.createElement('div').innerHTML = '<img src=x onerror=alert(1)>'; return false; } catch { return true; } }), 'The page must refuse raw HTML strings (Trusted Types)');
    assert(await page.evaluate(() => { try { document.createElement('script').src = '/elsewhere.js'; return false; } catch { return true; } }), 'Script URLs must go through a policy too');
    // Installable: Chrome reads the manifest under the real Content-Security-Policy, the installed window opens the room, and each icon is the size it says.
    const cdp = await page.context().newCDPSession(page);
    const { url: manifestUrl, data: manifestData, errors: manifestErrors } = await cdp.send('Page.getAppManifest');
    await cdp.detach();
    assert(manifestData && !manifestErrors.length, 'Chrome should read the web app manifest: ' + (manifestErrors.map(error => error.message).join('; ') || 'none is linked'));
    const manifest = JSON.parse(manifestData);
    assert(manifest.name === 'Flow' && manifest.display === 'standalone' && new URL(manifest.start_url, manifestUrl).href === origin + '/room.html', 'The installed app should be Flow, in its own window, opening the room');
    const iconSizes = await page.evaluate(icons => Promise.all(icons.map(icon => new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(icon.sizes === image.naturalWidth + 'x' + image.naturalHeight);
        image.onerror = () => reject(new Error('App icon did not load: ' + icon.src));
        image.src = icon.src;
    }))), manifest.icons);
    assert(['192x192', '512x512'].every(size => manifest.icons.some(icon => icon.sizes === size)) && iconSizes.every(Boolean), 'The manifest needs 192 and 512 pixel icons that match their stated sizes');
    await page.screenshot({ path: 'output/playwright/landing-desktop.png' });
    await page.getByRole('button', { name: 'Play the demo', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('preview-time').textContent !== '25:00' && Number(getComputedStyle(document.body).getPropertyValue('--sun-y')) > .43);
    await page.getByRole('button', { name: 'Daylight', exact: true }).click();
    assert(await page.locator('html').getAttribute('data-theme') === 'daylight', 'Landing swatches should change the atmosphere');
    // The browser's bars follow the sky: its top colour, at once, and again on the next visit.
    const themeColor = () => page.locator('meta[name="theme-color"]').getAttribute('content');
    assert(await themeColor() === 'rgb(127, 187, 230)', 'The theme colour should follow the chosen sky, not stay fixed');
    await page.reload();
    assert(await themeColor() === 'rgb(127, 187, 230)', 'A saved sky should set the theme colour when the page loads');
    await page.getByRole('button', { name: 'Forest', exact: true }).click();
    assert(await themeColor() === 'rgb(11, 42, 34)', 'The default sky should match the manifest\'s theme colour (#0b2a22)');
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
    await page.getByRole('button', { name: 'Step away', exact: true }).click();
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
    // Arriving partway through a block: the sun takes the room's place, and a note says so.
    await page.evaluate(() => window.__fixture.handlers['broadcast:timer-updated']({ payload: { action: 'sync', mode: 'focus', duration: 1500, timeLeft: 600, isRunning: true } }));
    await page.waitForFunction(() => document.getElementById('toast').textContent.includes('15 min into a focus block'));
    // Stepping away during the block: the room's clock carries on, your tile quiets down.
    await page.getByRole('button', { name: 'Be right back', exact: true }).hover();
    await page.waitForFunction(() => { const button = document.getElementById('toggle-away'); return button.dataset.tip.includes('pauses your focus time') && getComputedStyle(button, '::after').opacity === '1'; });
    await page.getByRole('button', { name: 'Be right back', exact: true }).click();
    assert(await page.locator('#video-wrapper-local').evaluate(tile => tile.classList.contains('is-away')) && await page.locator('#toggle-away').getAttribute('aria-pressed') === 'true', 'Stepping away should dim your tile');
    assert(await page.locator('#timer-toggle-btn').getAttribute('aria-pressed') === 'true', 'Stepping away must not touch the room\'s timer');
    await page.waitForFunction(() => document.body.textContent.includes('Stepped away'));
    await page.getByRole('button', { name: 'I’m back', exact: true }).click();
    await page.waitForFunction(() => /Welcome back\. \d+ min left in this block\./.test(document.getElementById('toast').textContent));
    assert(!await page.locator('#video-wrapper-local').evaluate(tile => tile.classList.contains('is-away')), 'Coming back should restore your tile');
    // Between blocks the same button means "start without me".
    await page.evaluate(() => window.__fixture.handlers['broadcast:timer-updated']({ payload: { action: 'sync', mode: 'shortBreak', duration: 300, timeLeft: 300, isRunning: false } }));
    await page.getByRole('button', { name: 'Back next block', exact: true }).click();
    await page.waitForFunction(() => document.body.textContent.includes('Back for the next block'));
    await page.getByRole('button', { name: 'I’m back', exact: true }).click();
    await page.evaluate(() => window.__fixture.handlers['broadcast:timer-updated']({ payload: { action: 'sync', mode: 'focus', duration: 1500, timeLeft: 1500, isRunning: false } }));
    // The digits can be hidden; the sun still shows the block, and the choice is remembered.
    await page.evaluate(() => window.__fixture.handlers['broadcast:timer-updated']({ payload: { action: 'sync', mode: 'focus', duration: 1500, timeLeft: 900, isRunning: true } }));
    await page.getByRole('button', { name: 'Hide time', exact: true }).click();
    await page.waitForFunction(() => getComputedStyle(document.getElementById('time-display')).visibility === 'hidden');
    assert(await page.title() === 'Focusing | Flow' && await page.evaluate(() => localStorage.getItem('flow_hide_time')) === '1', 'Hiding the time should hide the digits, also from the tab title');
    await page.getByRole('button', { name: 'Show time', exact: true }).click();
    await page.waitForFunction(() => getComputedStyle(document.getElementById('time-display')).visibility === 'visible');
    assert(/^\d\d:\d\d \| Flow$/.test(await page.title()), 'Showing the time brings the digits back');
    await page.evaluate(() => window.__fixture.handlers['broadcast:timer-updated']({ payload: { action: 'sync', mode: 'focus', duration: 1500, timeLeft: 1500, isRunning: false } }));
    // Someone else stepping away is shown on their tile only: no sound, no note.
    await page.evaluate(() => window.__fixture.handlers['presence:join']({ key: 'zz-away', newPresences: [{ username: 'Noor', isDummyMedia: true, status: 'Stepped away' }] }));
    await page.waitForFunction(() => document.getElementById('video-wrapper-zz-away')?.classList.contains('is-away'));
    await page.evaluate(() => window.__fixture.handlers['broadcast:bye']({ payload: { userId: 'zz-away' } }));
    await page.waitForFunction(() => !document.getElementById('video-wrapper-zz-away'), undefined, { timeout: 10000 });
    assert(await page.locator('#toggle-cam').getAttribute('aria-pressed') === 'false', 'Unavailable camera should display its off state');
    await page.locator('.reactions-menu summary').click();
    for (const name of ['Thumbs up', 'Heart', 'Laugh', 'Celebrate']) await page.getByRole('button', { name, exact: true }).click();
    // Reactions are drawn icons thrown into the tile; they settle on its floor and are gone after a few seconds.
    assert(await page.locator('#video-wrapper-local .floating-reaction svg').count() === 4, 'Each reaction shows its icon, not an emoji');
    await page.waitForTimeout(2500);
    assert(await page.locator('#video-wrapper-local').evaluate(tile => [...tile.querySelectorAll('.floating-reaction')].every(el => { const box = el.getBoundingClientRect(), frame = tile.getBoundingClientRect(); return box.left >= frame.left - 1 && box.right <= frame.right + 1 && box.bottom <= frame.bottom + 1; })), 'Reactions stay inside the tile');
    await page.waitForFunction(() => !document.querySelector('#video-wrapper-local .floating-reaction'), undefined, { timeout: 4000 });
    await page.getByRole('button', { name: 'Raise hand', exact: true }).click();
    await visible('.hand-raised-badge');
    await page.getByRole('button', { name: 'Raise hand', exact: true }).click();
    assert(await page.locator('.reactions-menu').evaluate(menu => menu.open), 'Picking reactions keeps the tray open');
    await page.locator('.stage-header h1').click();
    assert(!await page.locator('.reactions-menu').evaluate(menu => menu.open), 'Clicking anywhere else closes the reaction tray');
    await page.locator('.reactions-menu summary').click();
    await page.keyboard.press('Escape');
    assert(!await page.locator('.reactions-menu').evaluate(menu => menu.open), 'Escape closes the reaction tray');
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
    // C opens chat ready to type and N opens notifications; both leave focus mode, and typing a message never triggers them.
    const focusedId = () => page.evaluate(() => document.activeElement?.id);
    const notificationsOpen = () => page.locator('#notify').evaluate(panel => panel.open);
    await page.locator('.stage-header h1').click();
    await page.keyboard.press('c');
    assert(await page.getByRole('tab', { name: 'Chat', exact: true }).getAttribute('aria-selected') === 'true' && await focusedId() === 'chat-input' && await page.locator('#chat-input').inputValue() === '', 'C should open the Chat tab with the message box focused');
    await page.keyboard.press('n');
    assert(await page.locator('#chat-input').inputValue() === 'n' && !await notificationsOpen(), 'Typing a message must not trigger shortcuts');
    await page.locator('#chat-input').fill('');
    await page.locator('.stage-header h1').click();
    await page.keyboard.press('n');
    assert(await notificationsOpen() && await focusedId() === 'notify-summary', 'N should open notifications');
    await page.locator('.stage-header h1').click();
    assert(!await notificationsOpen(), 'Clicking elsewhere should close notifications');
    await page.keyboard.press('f');
    await page.keyboard.press('n');
    assert(!await page.evaluate(() => document.body.classList.contains('focus-active')) && await notificationsOpen(), 'N should leave focus mode to show notifications');
    await page.locator('.stage-header h1').click();
    await page.keyboard.press('f');
    await page.keyboard.press('c');
    assert(!await page.evaluate(() => document.body.classList.contains('focus-active')) && await focusedId() === 'chat-input', 'C should leave focus mode to show chat');
    await page.locator('#chat-input').blur();

    // Soundscape buttons are exclusive toggles and generate audio locally.
    await page.getByRole('tab', { name: 'Sound', exact: true }).click();
    for (const name of ['Rain', 'Ocean', 'Fireplace', 'Wind', 'Night', 'Deep hum']) await page.getByRole('button', { name, exact: true }).click();
    await page.getByRole('button', { name: 'Rain', exact: true }).click();
    await page.getByRole('button', { name: 'Ocean', exact: true }).click();
    assert(await page.getByRole('button', { name: 'Rain', exact: true }).getAttribute('aria-pressed') === 'false' && await page.getByRole('button', { name: 'Ocean', exact: true }).getAttribute('aria-pressed') === 'true', 'Only one soundscape plays at a time');
    await page.getByRole('button', { name: 'Ocean', exact: true }).click();
    assert(await page.getByRole('button', { name: 'Ocean', exact: true }).getAttribute('aria-pressed') === 'false', 'Clicking the active soundscape stops it');
    assert(await page.locator('#sound-volume').inputValue() === '40', 'The soundscape volume starts at its default');
    await page.locator('#sound-volume').fill('65');
    assert(await page.evaluate(() => localStorage.getItem('flow_sound_volume')) === '65', 'A new soundscape volume should be saved');
    await page.getByRole('tab', { name: 'Tasks', exact: true }).click();

    // A message's name comes from who the database says sent it, not from what the message claims.
    await page.evaluate(() => {
        const fixture = window.__fixture;
        fixture.handlers['presence:join']({ key: 'zz-sam', newPresences: [{ username: 'Sam', isDummyMedia: true }] });
        fixture.handlers['broadcast:chat-message']({ payload: { sender: 'Riya', text: 'Pretending to be Riya', from: 'zz-sam' } });
        fixture.handlers['broadcast:chat-message']({ payload: { sender: 'AI Assistant', text: 'Pretending to be the assistant', from: 'zz-sam' } });
        fixture.handlers['broadcast:bye']({ payload: { userId: 'zz-sam' } });
    });
    assert(JSON.stringify(await page.locator('#chat-messages .message-sender').allInnerTexts()) === JSON.stringify(['Sam', 'AI Assistant, asked by Sam']), 'Chat must show the verified sender');
    await page.waitForFunction(() => !document.getElementById('video-wrapper-zz-sam'), undefined, { timeout: 10000 }); // the goodbye clears their tile
    await page.evaluate(() => { document.getElementById('chat-messages').replaceChildren(); document.getElementById('chat-unread').textContent = '0'; document.getElementById('chat-unread').classList.add('hidden'); document.getElementById('notify-clear').click(); });

    // A chat message that would go unseen raises a badge on the tab and a line in the notification centre.
    await page.evaluate(() => window.__fixture.handlers['broadcast:chat-message']({ payload: { sender: 'Riya', text: '<b>Ready</b> when you are' } }));
    assert(await page.locator('#chat-unread').innerText() === '1' && await page.locator('#notify-count').innerText() === '1', 'An unseen message should be counted in both places');
    await page.locator('#notify-summary').click();
    assert((await page.locator('#notify-list').innerText()).includes('Riya: <b>Ready</b> when you are') && await page.locator('#notify-list b').count() === 0, 'Notifications must show message text as text');
    await page.locator('#notify-count').waitFor({ state: 'hidden' }); // opening the list marks it read
    await page.locator('#notify-list button').first().click();
    assert(await page.getByRole('tab', { name: 'Chat', exact: true }).getAttribute('aria-selected') === 'true' && await page.locator('#chat-unread').isHidden(), 'A message notification should open the chat and clear its badge');
    await page.evaluate(() => window.__fixture.handlers['broadcast:chat-message']({ payload: { sender: 'Riya', text: 'Seen straight away' } }));
    assert(await page.locator('#chat-unread').isHidden(), 'A message read as it arrives needs no badge');
    await page.getByRole('tab', { name: 'Tasks', exact: true }).click();

    // Reminders: set from chat, listed in the bell, cancelled, and fired by the timer; never posted to the room.
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
    const sendsBefore = await page.evaluate(() => window.__fixture.calls.filter(call => call.value?.event === 'chat-message').length);
    await page.getByLabel('Message to room').fill('/remind 20m stretch');
    await page.getByLabel('Message to room').press('Enter');
    assert((await page.locator('#chat-messages .local-note').last().innerText()).includes('Reminder set in 20 min'), 'A reminder is confirmed privately in the chat');
    await page.getByLabel('Message to room').fill('/remind break drink water');
    await page.getByLabel('Message to room').press('Enter');
    await page.getByLabel('Message to room').fill('/remind sometime maybe');
    await page.getByLabel('Message to room').press('Enter');
    assert(await page.getByLabel('Message to room').inputValue() === '/remind sometime maybe', 'An unreadable reminder keeps the text for fixing');
    await page.getByLabel('Message to room').fill('');
    assert(await page.evaluate(() => window.__fixture.calls.filter(call => call.value?.event === 'chat-message').length) === sendsBefore, 'Reminders are never sent to the room');
    await page.locator('#notify-summary').click();
    assert((await page.locator('#reminder-list').innerText()).includes('stretch') && (await page.locator('#reminder-list').innerText()).includes('drink water'), 'Upcoming reminders are listed in the bell');
    await page.getByRole('button', { name: 'Cancel reminder: stretch', exact: true }).click();
    assert(!(await page.locator('#reminder-list').innerText()).includes('stretch'), 'A reminder can be cancelled');
    await page.locator('#notify-summary').click();
    assert(await page.evaluate(() => JSON.parse(localStorage.getItem('flow_reminders')).length) === 1, 'Reminders survive a reload');
    await page.getByRole('button', { name: 'Break', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('notify-list').textContent.includes('Reminder: drink water'));
    assert(await page.locator('#reminders').isHidden(), 'A fired reminder leaves the list');
    await page.locator('#notify-summary').click();
    await page.getByRole('button', { name: 'Snooze 5 min', exact: true }).click();
    assert((await page.locator('#reminder-list').innerText()).includes('drink water'), 'Snoozing puts the reminder back');
    await page.getByRole('button', { name: 'Cancel reminder: drink water', exact: true }).click();
    await page.locator('#notify-summary').click();
    await page.getByRole('button', { name: 'Focus', exact: true }).click();
    // Asked in words: the assistant's reminder is kept private too.
    await page.route('**/api/ai', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ text: '', reminder: { text: 'review notes', at: new Date(Date.now() + 3 * 60000).toISOString() } }) }));
    await page.getByLabel('Message to room').fill('/ai remind me to review notes in 3 minutes');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#chat-messages .local-note:last-child')?.textContent.includes('review notes'));
    assert(await page.evaluate(() => window.__fixture.calls.filter(call => call.value?.event === 'chat-message').length) === sendsBefore, 'An assistant reminder is not posted to the room');
    await page.unroute('**/api/ai');
    await page.locator('#notify-summary').click();
    await page.getByRole('button', { name: 'Cancel reminder: review notes', exact: true }).click();
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await page.locator('#notify-summary').click();
    await page.evaluate(() => document.getElementById('chat-messages').replaceChildren());
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

    // The room code in the header copies itself, by mouse or keyboard.
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__copied = text; } } }));
    const codeButton = page.getByRole('button', { name: 'Copy room code FOCUS6', exact: true });
    await codeButton.click();
    assert(await page.evaluate(() => window.__copied) === 'FOCUS6', 'Clicking the room code should copy it');
    assert((await page.locator('#toast').innerText()) === 'Room code copied.', 'Copying the room code should confirm with a toast');
    await page.evaluate(() => { window.__copied = ''; });
    await codeButton.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__copied === 'FOCUS6');
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Denied'); } } }));
    await codeButton.click();
    await page.waitForFunction(() => document.getElementById('toast').textContent.includes('The room code is FOCUS6'));

    // Clipboard denial falls back to a selectable invite link.
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Denied'); } } }));
    await page.getByRole('button', { name: 'Invite', exact: true }).click();
    await visible('#invite-modal');
    assert((await page.locator('#invite-link-input').inputValue()).includes('room=FOCUS6'), 'Fallback invite should include room code');
    await page.getByRole('button', { name: 'Done', exact: true }).click();

    // All appearance themes maintain readable body text.
    for (const theme of ['forest', 'midnight', 'warm', 'aqua', 'amethyst', 'desert', 'aurora', 'storm', 'dawn', 'daylight']) {
        await page.getByLabel('Room atmosphere').selectOption(theme);
        // Skies cross-fade, so wait for the ground colour to settle before measuring.
        await page.waitForFunction(() => {
            const style = getComputedStyle(document.body);
            const luminance = color => {
                const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
                return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
            };
            const a = luminance(style.color), b = luminance(style.backgroundColor);
            return (Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 4.5;
        }, undefined, { timeout: 3000 }).catch(() => { throw new Error(theme + ' body text contrast'); });
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

    // Chat formatting: a safe subset of Markdown, built as elements and never parsed as HTML.
    const formatted = await page.evaluate(() => {
        window.__fixture.handlers['broadcast:chat-message']({ payload: { sender: 'AI Assistant', from: 'zz-format', text: 'To get started:\n\n1. **Visit** the site at https://leetcode.com.\n2. Click *Sign Up* and run `npm ci`.\n\nSee [the guide](https://example.com/guide) or [this](javascript:alert(1)). <img src=x onerror=alert(1)>\n- one\n- two' } });
        const body = document.querySelector('#chat-messages .chat-message:last-child .message-body');
        return {
            steps: [...body.querySelectorAll('ol > li')].length, bullets: [...body.querySelectorAll('ul > li')].length,
            bold: body.querySelector('strong')?.textContent, italic: body.querySelector('em')?.textContent, code: body.querySelector('code')?.textContent,
            links: [...body.querySelectorAll('a')].map(a => [a.textContent, a.getAttribute('href'), a.rel]),
            stars: body.textContent.includes('**'), images: body.querySelectorAll('img, script, iframe').length, text: body.textContent
        };
    });
    assert(formatted.steps === 2 && formatted.bullets === 2 && formatted.bold === 'Visit' && formatted.italic === 'Sign Up' && formatted.code === 'npm ci' && !formatted.stars, 'Chat should render lists, bold, italics and code: ' + JSON.stringify(formatted));
    assert(JSON.stringify(formatted.links.map(link => link.slice(0, 2))) === JSON.stringify([['https://leetcode.com', 'https://leetcode.com/'], ['the guide', 'https://example.com/guide']]) && formatted.links.every(link => link[2].includes('noopener')), 'Only real web addresses become links: ' + JSON.stringify(formatted.links));
    assert(formatted.images === 0 && formatted.text.includes('<img src=x onerror=alert(1)>') && formatted.text.includes('this'), 'Markup in a message stays text');

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
    // An explicit goodbye needs no presence event at all: the tile says so and clears within seconds.
    await page.evaluate(() => window.__fixture.handlers['broadcast:bye']({ payload: { userId: 'zz-test-0' } }));
    assert(await page.locator('#video-wrapper-zz-test-0.left .left-note').count() === 1 && await page.locator('#count').innerText() === '1', 'A goodbye should show on the tile and drop the count at once');
    await page.clock.fastForward(4100);
    assert(await page.locator('.video-wrapper').count() === 1, 'A tile should clear a few seconds after a goodbye');
    // Neither presence nor a goodbye (a crashed browser): silence plus a dead call still clears the tile.
    await page.evaluate(() => window.__fixture.handlers['presence:join']({ key: 'zz-crashed', newPresences: [{ username: 'Crashed', isDummyMedia: true }] }));
    await page.clock.fastForward(60000);
    assert(await page.locator('#video-wrapper-zz-crashed').count() === 1, 'A quiet minute alone must not remove anyone');
    await page.clock.fastForward(50000);
    // The room's five-second check started before this fake clock was installed, so it runs in real time.
    await page.waitForFunction(() => !document.getElementById('video-wrapper-zz-crashed'), undefined, { timeout: 20000 }).catch(() => { throw new Error('A partner who vanished without a word should be cleared'); });

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
    await page.waitForFunction(() => window.__fixture.tables.sessions.some(row => row.mode === 'focus-partial' && row.duration_seconds >= 120));
    await page.clock.fastForward(60000);
    assert((await page.locator('#my-focus-time').textContent()).includes('2m'), 'Paused time must not count as focus, and saved time must not count twice');
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

    // The paused stretch was saved as partial focus. (The block that ran out here lasted under a
    // second, so whether it is long enough to store varies; it is never stored twice.)
    await page.waitForFunction(() => { const modes = window.__fixture.tables.sessions.map(row => row.mode); return modes.includes('focus-partial') && modes.filter(mode => mode === 'focus').length <= 1; });
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

    // Study-groups board: hosting opens a listed room, and the host can close seats and remove people.
    await page.goto(origin + '/groups.html');
    await page.locator('.group-empty').first().waitFor();
    for (const width of [1440, 390, 320]) { await page.setViewportSize({ width, height: 900 }); await fitsViewport(); }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: 'Open a room', exact: true }).click();
    assert(new URL(page.url()).pathname === '/groups.html', 'Hosting needs a topic');
    await page.getByLabel('What are you studying?').fill('<b>Linear algebra</b> problem set');
    await page.getByLabel('Subject', { exact: true }).selectOption('maths');
    await page.getByLabel('Cameras', { exact: true }).selectOption('off');
    await page.getByRole('button', { name: 'Open a room', exact: true }).click();
    await page.waitForURL(url => url.pathname === '/room.html');
    await page.waitForFunction(() => window.__fixture.tables.open_rooms.length === 1 && !document.getElementById('new-task-input').disabled);
    assert(await page.evaluate(() => { const row = window.__fixture.tables.open_rooms[0]; return row.seats === 4 && row.seats_taken === 1 && row.host_id === 'test-user' && row.subject === 'maths' && row.camera === 'off' && row.timer_mode === 'focus' && row.closed === false; }) && await page.evaluate(() => window.__fixture.calls.filter(call => call.table === 'open_rooms' && call.payload).every(call => !('last_seen' in call.payload))), 'A hosted room should be listed with its details, and never send its own last-seen time');
    await page.getByRole('button', { name: 'Invite', exact: true }).click();
    await visible('#board-unlist-btn');
    await page.getByLabel('Stop new people joining').check();
    await page.waitForFunction(() => window.__fixture.tables.open_rooms[0].closed === true);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    // The room's creator can remove someone; the database call comes first, then the nudge to their browser.
    await page.evaluate(() => window.__fixture.handlers['presence:join']({ key: 'zz-guest', newPresences: [{ username: 'Guest', isDummyMedia: true }] }));
    await page.locator('#video-wrapper-zz-guest').hover();
    await page.getByRole('button', { name: 'Remove Guest from the room', exact: true }).click();
    await visible('#remove-modal');
    await page.getByRole('button', { name: 'Remove from room', exact: true }).click();
    await page.waitForFunction(() => window.__fixture.calls.some(call => call.name === 'remove_participant') && window.__fixture.calls.some(call => call.value?.event === 'removed' && call.value.payload.userId === 'zz-guest'));
    // A "removed" message is only believed once the database agrees.
    await page.evaluate(() => window.__fixture.handlers['broadcast:removed']({ payload: { userId: 'test-user' } }));
    await page.waitForFunction(() => window.__fixture.calls.filter(call => call.name === 'join_room').length >= 2);
    assert(await page.locator('#app').isVisible(), 'A forged removal message must not eject anyone');
    // As host, with someone else here, leaving asks what happens to the room; "Just leave" takes the listing down.
    await page.getByRole('button', { name: 'Leave', exact: true }).click();
    await visible('#leave-host');
    assert(await page.locator('#leave-handover-row').isVisible() && await page.getByRole('button', { name: 'Step away', exact: true }).isVisible(), 'Handing over is offered when others are here; stepping away is the safe default');
    await page.getByText('End the room for everyone', { exact: true }).click();
    assert((await page.locator('#leave-end-text').innerText()).includes('comes off the board'), 'Ending says plainly that the listing goes');
    await page.getByText('Step away', { exact: true }).click();
    assert((await page.locator('#leave-away-text').innerText()).includes('hosts for now'), 'Stepping away says someone hosts for now');
    // Leaving loads a new page; keep what the board held as this one closed.
    await page.evaluate(() => addEventListener('pagehide', () => sessionStorage.setItem('test-board', JSON.stringify(window.__fixture.tables.open_rooms))));
    await page.getByRole('button', { name: 'Step away', exact: true }).click();
    await visible('#join-modal');
    assert(await page.evaluate(() => { const board = JSON.parse(sessionStorage.getItem('test-board') || '[]'); return board.length === 1 && !!board[0].away_until; }), 'Stepping away keeps the room on the board');
    assert((await page.locator('#lobby-recap').innerText()).startsWith('Last session:'), 'The lobby should recap the session just left');
    await page.locator('#lobby-board a').waitFor();

    // Handing a room over: the new host is chosen in the leave dialog, and the database does the rest.
    const enterNewRoom = async () => {
        await page.locator('input[name="audience"][value="private"]').check();
        await page.getByRole('button', { name: 'Create a room', exact: true }).click();
        await page.waitForFunction(() => !document.getElementById('new-task-input').disabled && document.body.classList.contains('is-host'));
        await page.evaluate(() => window.__fixture.handlers['presence:join']({ key: 'zz-next', newPresences: [{ username: 'Riya', isDummyMedia: true }] }));
    };
    await enterNewRoom();
    assert(await page.locator('#video-wrapper-local .host-badge').isVisible(), 'The host is marked on their tile');
    await page.getByRole('button', { name: 'Leave', exact: true }).click();
    assert(await page.locator('#leave-new-host').inputValue() === 'zz-next', 'The person here is offered as the new host');
    await page.getByText('End the room for everyone', { exact: true }).click();
    assert(await page.getByRole('button', { name: 'End room for everyone', exact: true }).isVisible(), 'The button says what will happen');
    await page.getByText('Hand it to', { exact: false }).click();
    // Leaving loads a new page, so keep this page's record of calls across it.
    await page.evaluate(() => addEventListener('pagehide', () => sessionStorage.setItem('test-rpcs', JSON.stringify(window.__fixture.calls.filter(call => call.action === 'rpc').map(call => call.name)))));
    await page.getByRole('button', { name: 'Hand over and leave', exact: true }).click();
    await visible('#join-modal');
    assert(await page.evaluate(() => JSON.parse(sessionStorage.getItem('test-rpcs') || '[]').includes('transfer_host')), 'Leaving as host hands the room over');

    // The database says someone else is host now: confirmed first, then shown to everyone.
    await enterNewRoom();
    await page.evaluate(() => window.__fixture.handlers['broadcast:host-changed']({ payload: { host: 'zz-next', name: 'Riya' } }));
    await page.waitForTimeout(300);
    assert(await page.evaluate(() => document.body.classList.contains('is-host')), 'A host change the database does not confirm is ignored');

    // The host steps away: someone here hosts for now, and gives it back when the host returns.
    await page.evaluate(() => {
        Object.assign(window.__fixture.tables.rooms.at(-1), { created_by: 'zz-next', host_away: true, acting_host: null });
        window.__fixture.handlers['broadcast:host-changed']({ payload: { host: '', name: '' } });
    });
    await page.waitForFunction(() => document.querySelector('#video-wrapper-local .host-badge'));
    assert(await page.evaluate(() => window.__fixture.tables.rooms.at(-1).acting_host === 'test-user' && !document.body.classList.contains('is-host')), 'Someone standing in is shown as host, without the host\'s powers');
    assert((await page.locator('#notify-list').textContent()).includes('You’re the room host for now.'), 'They are told they host for now');
    await page.getByRole('button', { name: 'Leave', exact: true }).click();
    assert((await page.locator('#leave-text').innerText()).includes('hosting for now') && await page.locator('#leave-host').isHidden(), 'Someone standing in is told what leaving does');
    await page.getByRole('button', { name: 'Stay in room', exact: true }).click();
    await page.evaluate(() => {
        Object.assign(window.__fixture.tables.rooms.at(-1), { host_away: false, acting_host: null });
        window.__fixture.handlers['broadcast:host-changed']({ payload: { host: 'zz-next', name: 'Riya' } });
    });
    await page.waitForFunction(() => document.querySelector('#video-wrapper-zz-next .host-badge') && !document.querySelector('#video-wrapper-local .host-badge'));
    assert((await page.locator('#notify-list').textContent()).includes('Riya is back and hosting again.'), 'The host gets the role back on return');
    await page.evaluate(() => { window.__fixture.tables.rooms.at(-1).created_by = 'test-user'; window.__fixture.handlers['broadcast:host-changed']({ payload: { host: 'test-user', name: 'Alex' } }); });
    await page.waitForFunction(() => document.body.classList.contains('is-host'));
    await page.evaluate(() => {
        window.__fixture.tables.rooms.at(-1).created_by = 'zz-next';
        window.__fixture.handlers['broadcast:host-changed']({ payload: { host: 'zz-next', name: 'Riya' } });
    });
    await page.waitForFunction(() => !document.body.classList.contains('is-host'));
    assert(await page.locator('#video-wrapper-zz-next .host-badge').isVisible() && await page.locator('#video-wrapper-local .host-badge').count() === 0, 'The new host is marked, and the old one is not');
    await page.evaluate(() => window.__fixture.handlers['broadcast:host-changed']({ payload: { host: 'zz-next', name: 'Riya', from: 'zz-next' } }));
    assert(await page.locator('#leave-host').isHidden(), 'Someone who is not host just leaves');

    // The host ends the room: everyone goes back Home quietly, with a calm note.
    await page.evaluate(() => { window.__fixture.rpcError = 'Room ended'; window.__fixture.handlers['broadcast:room-ended']({ payload: {} }); });
    await page.waitForURL(url => url.pathname === '/room.html' && !url.searchParams.get('room'));
    await visible('#join-modal');
    assert((await page.locator('#lobby-recap').innerText()).includes('The host ended the room') && await page.locator('#lobby-error').isHidden(), 'An ended room is a note, not an error');
    await page.evaluate(() => { window.__fixture.rpcError = null; });

    // Home: who you are, and one place to start a private room, open a listed one, join by code, or sit in a group.
    assert(await page.locator('#join-title').innerText() === 'Hi, Alex.', 'Home should greet the signed-in person by name');
    await page.getByRole('button', { name: 'Change name', exact: true }).click();
    await page.getByLabel('Your display name').fill('Alex R');
    await page.getByLabel('Your display name').press('Enter');
    await page.waitForFunction(() => document.getElementById('join-title').textContent === 'Hi, Alex R.');
    await page.locator('input[name="audience"][value="open"]').check();
    await page.getByRole('button', { name: 'Open a study group', exact: true }).click();
    await visible('#lobby-error');
    assert(await page.evaluate(() => window.__fixture.tables.rooms.length) === 0, 'An open group needs a topic before any room is made');
    await page.getByLabel('Topic for the board').fill('Past papers, timed');
    // The group's details sit on one line and open in a panel over the card, so Home never grows a scroll.
    const homeScroll = () => page.locator('#modal-overlay').evaluate(overlay => overlay.scrollHeight - overlay.clientHeight);
    const scrollBefore = await homeScroll();
    await page.getByText('Change', { exact: true }).click();
    assert(await homeScroll() === scrollBefore, 'Editing an open group\'s details must not make Home scroll');
    await page.getByLabel('Subject', { exact: true }).first().selectOption('exams');
    assert(await page.locator('#create-camera').inputValue() === 'optional' && await page.locator('#create-vibe').inputValue() === 'quiet', 'A group opened from home should default to optional cameras and quiet');
    await page.getByLabel('Cameras', { exact: true }).first().selectOption('on');
    await page.getByLabel('Talking', { exact: true }).first().selectOption('chatty');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    assert(await page.locator('#create-summary').innerText() === 'Exam prep · 4 seats · Cameras on · Chatty', 'The summary line should show the chosen details');
    await page.getByRole('button', { name: 'Open a study group', exact: true }).click();
    await page.waitForFunction(() => window.__fixture.tables.open_rooms.length === 1 && !document.getElementById('new-task-input').disabled);
    assert(await page.evaluate(() => { const row = window.__fixture.tables.open_rooms[0]; return row.topic === 'Past papers, timed' && row.subject === 'exams' && window.__fixture.tables.rooms.at(-1).is_locked === false; }), 'Opening a study group from home should create an unlocked room and list it');
    assert(await page.evaluate(() => { const row = window.__fixture.tables.open_rooms[0]; return row.camera === 'on' && row.vibe === 'chatty'; }), 'A group opened from home should carry the chosen camera and talking rules onto the board');
    await page.getByRole('button', { name: 'Leave', exact: true }).click();
    await page.getByRole('button', { name: 'Step away', exact: true }).click();
    await visible('#join-modal');
    for (const width of [1440, 768, 390, 320]) { await page.setViewportSize({ width, height: 900 }); await fitsViewport(); }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(origin + '/room.html?board');
    await page.getByRole('button', { name: /^Take a seat in Organic chemistry/ }).click();
    await visible('#app');
    assert(await page.locator('#header-room-code').innerText() === 'FOCUS6', 'A seat taken from home should lead straight into that room');
    assert(await page.locator('#sound-volume').inputValue() === '65', 'The soundscape volume should be remembered between visits');
    await page.getByRole('button', { name: 'Leave', exact: true }).click();
    await page.getByRole('button', { name: 'Leave room', exact: true }).click();
    await visible('#join-modal');

    // Browsing: search, subjects, plans, reports, and a seat that leads straight into the room.
    await page.goto(origin + '/groups.html?board');
    await page.locator('.group').first().waitFor();
    // An expired listing never shows, and your own is taken off the board.
    await page.evaluate(() => {
        const stale = new Date(Date.now() - 5 * 60000).toISOString();
        window.__fixture.tables.open_rooms.push({ id: 'stale-mine', host_id: 'test-user', host_name: 'Alex', topic: 'Left an hour ago', subject: 'other', camera: 'optional', vibe: 'quiet', seats: 4, seats_taken: 1, closed: false, timer_mode: 'focus', timer_ends_at: null, last_seen: stale });
        window.__fixture.tables.open_rooms.push({ id: 'stale-theirs', host_id: 'kai', host_name: 'Kai', topic: 'Gone quiet', subject: 'other', camera: 'optional', vibe: 'quiet', seats: 4, seats_taken: 1, closed: false, timer_mode: null, timer_ends_at: null, last_seen: stale });
    });
    await page.getByRole('button', { name: 'Refresh', exact: true }).click().catch(() => {});
    await page.reload();
    await page.locator('.group').first().waitFor();
    assert(!(await page.locator('#board-list').innerText()).match(/Left an hour ago|Gone quiet/), 'Expired listings must not be shown');
    await page.waitForFunction(() => !window.__fixture.tables.open_rooms.some(row => row.id === 'stale-mine'));
    await page.screenshot({ path: 'output/playwright/groups-desktop.png', fullPage: true });
    assert(await page.locator('#board-list .group').count() === 3 && await page.locator('#planned-list .group').count() === 2, 'Open and planned groups are listed separately');
    assert((await page.locator('#board-list .group-status').first().innerText()).startsWith('Focusing, 14 min'), 'A card should say what the room is doing');
    assert(await page.getByRole('button', { name: 'Full', exact: true }).isDisabled(), 'A full group cannot be joined');
    await page.getByLabel('Search topics').fill('essay');
    assert(await page.locator('#board-list .group').count() === 1, 'Search should narrow the board');
    await page.getByLabel('Search topics').fill('');
    await page.getByRole('button', { name: 'Languages', exact: true }).click();
    assert(await page.locator('#board-list .group').count() === 0 && await page.locator('#planned-list .group').count() === 1, 'Subject chips filter both lists');
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await page.getByRole('button', { name: 'I’m in', exact: true }).first().click();
    await page.getByRole('button', { name: 'You’re in', exact: true }).waitFor();
    assert(await page.evaluate(() => window.__fixture.tables.planned_groups[0].going) === 4, 'Saying you are in should count');
    await page.getByRole('button', { name: 'Report', exact: true }).first().click();
    assert(await page.evaluate(() => window.__fixture.tables.reports.length) === 0, 'One click must not file a report');
    await page.getByRole('button', { name: 'Report this listing?', exact: true }).click();
    await page.waitForFunction(() => window.__fixture.tables.reports.length === 1);
    await page.getByLabel('What are you studying?').fill('Thermodynamics problem sheet');
    await page.getByLabel('Later').check();
    await page.getByRole('button', { name: 'Put it on the board', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).waitFor();
    assert(await page.evaluate(() => { const plan = window.__fixture.tables.planned_groups.at(-1); return plan.host_id === 'test-user' && plan.host_name === 'Alex' && new Date(plan.starts_at) > new Date(); }), 'A planned group should be saved with a future start');
    assert(await page.getByRole('button', { name: 'Start now', exact: true }).isDisabled(), 'A plan cannot be started long before its time');
    assert(await page.locator('.group b, .group img').count() === 0, 'Group topics must stay inert');
    await page.getByRole('button', { name: 'Find me a seat', exact: true }).click();
    await page.waitForURL(url => url.pathname === '/room.html' && url.searchParams.get('room') === 'FOCUS6');
    await visible('#app');
    // A link alone must never put someone in a room: it fills in the code and waits for a click.
    await page.goto(origin + '/room.html?room=FOCUS6&join=1');
    await visible('#join-modal');
    assert(await page.locator('#app').isHidden() && await page.locator('#room-code-input').inputValue() === 'FOCUS6', 'A URL must not auto-join a room');
    // Signed out, the board is readable but nothing on it can be used.
    await page.evaluate(() => { localStorage.removeItem('flow_signed_in'); localStorage.removeItem('fixture-session'); });
    await page.goto(origin + '/groups.html?board');
    await page.locator('.group').first().waitFor();
    assert(await page.getByRole('link', { name: 'Log in to join', exact: true }).count() === 5 && await page.locator('#host-form').isHidden() && await page.getByRole('button', { name: 'Report', exact: true }).count() === 0, 'Visitors can read the board but not act on it');
    await page.goto(origin + '/');
    await page.locator('#live-groups.live').waitFor({ timeout: 1 }).catch(() => {});
    await page.evaluate(() => { localStorage.setItem('flow_signed_in', '1'); localStorage.setItem('fixture-session', '1'); });
    await page.goto(origin + '/docs.html');
    for (const width of [1440, 390, 320]) { await page.setViewportSize({ width, height: 900 }); await fitsViewport(); }
    await page.setViewportSize({ width: 1440, height: 1000 });

    await page.evaluate(() => { localStorage.removeItem('flow_signed_in'); localStorage.removeItem('fixture-session'); });
    await page.goto(origin + '/login.html');
    await page.screenshot({ path: 'output/playwright/after-login-mobile.png', fullPage: true });

    // New accounts are made in setup: the login page's "Create an account" goes there, keeping an invite.
    await page.goto(origin + '/login.html?room=FOCUS6');
    await page.getByRole('link', { name: 'Create an account', exact: true }).click();
    await page.waitForURL(origin + '/start.html?room=FOCUS6');
    await page.goto(origin + '/login.html?room=FOCUS6');
    await page.getByLabel('Email address').fill('alex@example.com');
    await page.getByLabel('Password', { exact: true }).fill('test-password');
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    await page.waitForURL(origin + '/room.html?room=FOCUS6');
    await visible('#join-modal');
    // Arriving from an invite: Home says so, and joining is the main action.
    assert(await page.locator('#join-heading').innerText() === 'You’re invited' && (await page.locator('#join-hint').innerText()).includes('FOCUS6'), 'Home should say you were invited');
    assert(await page.locator('#join-btn').evaluate(button => button.classList.contains('btn-primary')) && !(await page.locator('#host-btn').evaluate(button => button.classList.contains('btn-primary'))), 'Join should be the main button when invited');
    assert(await page.locator('#app').isHidden(), 'An invite still waits for Join');
    // Signed in, every page calls the after-login screen Home.
    for (const path of ['/', '/groups.html', '/docs.html']) {
        await page.goto(origin + path);
        assert(await page.getByRole('link', { name: 'Home', exact: true }).first().getAttribute('href') === '/room.html', path + ' should link to Home');
    }
    // A missing or unusable stored volume falls back to the default.
    for (const stored of ['loud', '150', '-5', '', null]) {
        await page.evaluate(value => value === null ? localStorage.removeItem('flow_sound_volume') : localStorage.setItem('flow_sound_volume', value), stored);
        await page.goto(origin + '/room.html');
        await visible('#join-modal');
        assert(await page.locator('#sound-volume').inputValue() === '40', 'A stored volume of ' + JSON.stringify(stored) + ' should fall back to the default');
    }
    // Flow keeps no copy of the account: nothing it stores holds the email or id.
    assert(await page.evaluate(() => Object.keys(localStorage).filter(key => key !== 'fixture-session').every(key => !/alex@example\.com|test-user/.test(localStorage.getItem(key)))), 'The account must not be copied into browser storage');
    await page.getByRole('link', { name: 'Log out', exact: true }).click();
    await page.waitForURL(origin + '/login.html');
    assert(await page.evaluate(() => localStorage.getItem('flow_signed_in')) === null, 'Logout must clear the signed-in flag');
    // A flag without a session (or an old stored copy of the account) is not a sign-in.
    await page.evaluate(() => { localStorage.setItem('flow_signed_in', '1'); localStorage.setItem('flow_user', '{"id":"test-user","email":"alex@example.com"}'); });
    await page.goto(origin + '/room.html');
    await page.waitForURL(origin + '/login.html');
    assert(await page.evaluate(() => localStorage.getItem('flow_user') === null && localStorage.getItem('flow_signed_in') === null), 'A stale flag and an old copy of the account are cleared');
    assert(failures.length === 0, 'Uncaught browser errors: ' + failures.join('; '));
    return { passed: true, taskRows: 500, reconciliations: 5, taskRenderMs: taskTiming, incomingMessages: 1000, retainedMessages: 300, simulatedParticipants: 16, localWebRTC: rtcResult, cleanup, browserErrors: failures };

}

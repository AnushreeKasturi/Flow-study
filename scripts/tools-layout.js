// Run after ui-smoke.js through browser-ci.cjs with its isolated backend fixture.
async page => {
    const origin = new URL(page.url()).origin;
    const assert = (condition, message) => { if (!condition) throw new Error(message); };
    assert(await page.evaluate(() => !!window.__fixture), 'Run ui-smoke.js first; this check requires its isolated backend fixture.');
    if (new URL(page.url()).pathname !== '/login.html') await page.goto(origin + '/login.html');
    await page.getByLabel('Email address').fill('alex@example.com');
    await page.getByLabel('Password', { exact: true }).fill('test-password');
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    await page.waitForURL(origin + '/');
    await page.getByLabel('Room code', { exact: true }).fill('FOCUS6');
    await page.getByRole('button', { name: 'Join room', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('new-task-input').disabled);
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();

    const input = page.getByLabel('Message to room');
    await input.fill('First line');
    await input.press('Shift+Enter');
    await input.pressSequentially('Second line');
    assert(await input.inputValue() === 'First line\nSecond line', 'Shift+Enter should insert a line break without sending.');
    await input.press('Enter');
    await page.waitForFunction(() => document.getElementById('chat-messages').textContent.includes('First line\nSecond line'));
    await page.evaluate(async () => {
        const chat = { handleIncomingMessage: payload => window.__fixture.handlers['broadcast:chat-message']({ payload }) };
        chat.handleIncomingMessage({ sender: 'Riya', text: 'I’m reviewing the practice set. Let’s work through question 3 in this session.' });
        chat.handleIncomingMessage({ sender: 'AI Assistant', text: 'Start by identifying what the question asks you to find.\n\nWrite down the known values, choose the relevant relationship, and work through one step at a time. Compare your result with your study partner before moving on.' });
    });
    await page.getByLabel('Room atmosphere').selectOption('amethyst');


    const measurements = [];
    for (const [width, height] of [[1440, 900], [1366, 768], [1280, 720], [1366, 600], [1100, 650], [1440, 500], [1024, 768], [768, 1024], [390, 844], [320, 568]]) {
        await page.setViewportSize({ width, height });
        await page.waitForFunction(({ width, height }) => {
            if (innerWidth !== width || innerHeight !== height) return false;
            if (!matchMedia('(width: ' + width + 'px) and (height: ' + height + 'px)').matches) return false;
            if (width > 1050) return Math.abs(document.getElementById('app').getBoundingClientRect().height - height) < 1;
            const expected = width <= 760 ? Math.min(760, Math.max(560, height - 100)) : Math.max(480, Math.min(720, height - 120));
            return Math.abs(document.querySelector('.right-sidebar').getBoundingClientRect().height - expected) < 1;
        }, { width, height }, { polling: 50 });
        const layout = await page.evaluate(() => {
            const panel = document.querySelector('.right-sidebar');
            const timer = document.querySelector('.pill-timer');
            const log = document.getElementById('chat-messages');
            const compose = document.querySelector('.chat-compose');
            const rect = panel.getBoundingClientRect();
            return {
                width: innerWidth, height: innerHeight,
                pageFits: document.documentElement.scrollWidth <= innerWidth,
                panelFits: panel.scrollHeight <= panel.clientHeight + 1,
                panelBottom: rect.bottom,
                composerBottom: compose.getBoundingClientRect().bottom,
                timerHeight: Math.round(timer.getBoundingClientRect().height),
                chatHeight: Math.round(log.getBoundingClientRect().height),
                modeButtonsFit: [...document.querySelectorAll('.mode-btn')].every(button => button.getBoundingClientRect().right <= rect.right)
            };
        });
        measurements.push(layout);
        assert(layout.pageFits && layout.panelFits && layout.modeButtonsFit, width + 'x' + height + ': panel or controls overflow');
        assert(layout.chatHeight >= (height <= 560 && width > 1050 ? 80 : 110), width + 'x' + height + ': message area is too cramped (' + layout.chatHeight + 'px)');
        assert(layout.composerBottom <= layout.panelBottom, width + 'x' + height + ': composer should remain inside panel');
        if (width > 1050) assert(layout.panelBottom <= height + 1, width + 'x' + height + ': tools should fit the viewport ' + JSON.stringify(layout));
        if (width === 1440 && height === 900) await page.screenshot({ path: 'output/playwright/workspace-amethyst.png', fullPage: true });
        if (width === 1440 && height === 900) await page.locator('.right-sidebar').screenshot({ path: 'output/playwright/tools-amethyst-desktop.png' });
        if (width === 1366 && height === 600) await page.locator('.right-sidebar').screenshot({ path: 'output/playwright/tools-amethyst-short-desktop.png' });
        if (width === 390) await page.locator('.right-sidebar').screenshot({ path: 'output/playwright/tools-amethyst-mobile.png' });
        await page.getByRole('button', { name: 'Toggle Focus Mode', exact: true }).click();
        await page.waitForFunction(() => document.body.classList.contains('focus-active'));
        assert(await page.locator('#focus-mode-toggle').isVisible(), 'Focus mode must retain its exit control');
        await page.waitForFunction(() => {
            const rect = document.querySelector('.right-sidebar').getBoundingClientRect();
            return [...document.querySelectorAll('.mode-btn')].filter(button => button.getClientRects().length).every(button => button.scrollWidth <= button.clientWidth && button.getBoundingClientRect().right <= rect.right) && rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight && rect.top >= 0;
        }, undefined, { polling: 50 });
        if (width === 1440 && height === 900) await page.screenshot({ path: 'output/playwright/fullscreen-amethyst.png' });
        await page.getByRole('button', { name: 'Toggle Focus Mode', exact: true }).click();
        await page.waitForFunction(() => !document.body.classList.contains('focus-active'));
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByLabel('Room atmosphere').selectOption('forest');
    await page.locator('.right-sidebar').screenshot({ path: 'output/playwright/tools-forest-desktop.png' });
    const icon = await page.evaluate(async () => {
        const link = document.querySelector('link[rel="icon"]');
        const image = new Image();
        image.src = link.href;
        await image.decode();
        return { path: new URL(link.href).pathname, width: image.naturalWidth, height: image.naturalHeight };
    });
    assert(icon.path === '/favicon.svg' && icon.width > 0, 'The outlined favicon should load');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.locator('#my-presence-card').click();
    await page.waitForFunction(() => {
        const modal = document.getElementById('profile-modal');
        return !modal.classList.contains('hidden') && !modal.style.transform && !modal.style.opacity;
    });
    await page.locator('#close-profile-btn').click();
    // Close during the entrance, then change the OS preference during a new entrance.
    await page.evaluate(() => {
        document.getElementById('my-presence-card').click();
        document.getElementById('close-profile-btn').click();
        document.getElementById('my-presence-card').click();
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => {
        const modal = document.getElementById('profile-modal');
        return !modal.style.transform && !modal.style.opacity && document.getElementById('app').inert;
    });
    await page.keyboard.press('Escape');
    assert(await page.locator('#modal-overlay').isHidden(), 'Interrupted motion must not reopen a closed dialog');
    assert(await page.locator('#my-presence-card').evaluate(element => element === document.activeElement), 'Motion must preserve focus restoration');
    await page.getByRole('tab', { name: 'Tasks', exact: true }).click();
    assert(await page.locator('#tasks-tab').evaluate(element => !element.style.opacity && !element.style.transform), 'Reduced motion should leave panels immediately readable');
    return { passed: true, motionPreferences: true, shiftEnter: true, favicon: icon, measurements };
}

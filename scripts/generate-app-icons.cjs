const { chromium } = require('playwright');
const { resolve } = require('node:path');
const { readFileSync } = require('node:fs');

// The installable app's icons, drawn from the favicon so the two never drift apart.
// Safari and iOS use the 180px apple-touch-icon and round its corners themselves, so it's opaque.
const icons = [
    { size: 192, file: 'icon-192.png' },
    { size: 512, file: 'icon-512.png' },
    { size: 180, file: 'apple-touch-icon.png', background: '#0a1a15' },
];

(async () => {
    const svg = readFileSync(resolve(__dirname, '../public/favicon.svg'));
    const src = 'data:image/svg+xml;base64,' + svg.toString('base64');
    const browser = await chromium.launch({ headless: true });
    try {
        for (const { size, file, background = 'transparent' } of icons) {
            const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
            await page.setContent(`<style>html, body { margin: 0; background: ${background}; } img { display: block; }</style><img src="${src}" width="${size}" height="${size}" alt="">`);
            await page.locator('img').evaluate(image => image.decode());
            await page.screenshot({ path: resolve(__dirname, `../public/${file}`), omitBackground: background === 'transparent' });
            await page.close();
        }
        console.log('Generated ' + icons.map(icon => `public/${icon.file}`).join(', ') + ' from public/favicon.svg');
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });

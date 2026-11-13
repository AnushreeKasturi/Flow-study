const { chromium } = require('playwright');
const { resolve } = require('node:path');
const { readFileSync } = require('node:fs');

// The installable app's icons, drawn from the favicon so the two never drift apart.
const sizes = [192, 512];

(async () => {
    const svg = readFileSync(resolve(__dirname, '../public/favicon.svg'));
    const src = 'data:image/svg+xml;base64,' + svg.toString('base64');
    const browser = await chromium.launch({ headless: true });
    try {
        for (const size of sizes) {
            const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
            await page.setContent(`<style>html, body { margin: 0; background: transparent; } img { display: block; }</style><img src="${src}" width="${size}" height="${size}" alt="">`);
            await page.locator('img').evaluate(image => image.decode());
            // Transparent outside the favicon's rounded square, as an app icon expects.
            await page.screenshot({ path: resolve(__dirname, `../public/icon-${size}.png`), omitBackground: true });
            await page.close();
        }
        console.log('Generated ' + sizes.map(size => `public/icon-${size}.png`).join(' and ') + ' from public/favicon.svg');
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });

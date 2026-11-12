const { chromium } = require('playwright');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
        await page.goto(pathToFileURL(resolve(__dirname, 'social-preview.html')).href);
        const fonts = await page.evaluate(() => document.fonts.load('500 64px "Bricolage"').then(loaded => loaded.length));
        if (!fonts) throw new Error('The Bricolage Grotesque font did not load (run npm ci first); preview was not generated.');
        await page.locator('.sky').evaluate(image => image.decode());
        // JPEG: the image is photographic, so it is a fraction of the size of a PNG.
        await page.screenshot({ path: resolve(__dirname, '../public/social-preview.jpg'), type: 'jpeg', quality: 92 });
        console.log('Generated public/social-preview.jpg (1200 × 630)');
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });

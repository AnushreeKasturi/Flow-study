// The two pictures at the top of Flow's auth emails, the same scene as the landing page's footer:
// the wordmark in silhouette on the horizon, its dot the sun (sign-up) or the moon (password reset).
// Email clients can't be trusted with web fonts or gradients, so the scene ships as an image.
//   npm run art:email   (writes public/email/*.jpg, served from the site the emails link to)
const { chromium } = require('playwright');
const { mkdirSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const OUT = resolve(__dirname, '../public/email');
const font = readFileSync(resolve(__dirname, '../node_modules/@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2')).toString('base64');
const grain = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='220'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='220' height='220' filter='url(%23n)'/%3E%3C/svg%3E\")";

// top and bottom of the sky, the ground (which is also the email card under the picture), the light, and how much of it shows.
const scenes = {
    sunrise: { top: '#08201a', bottom: '#5f9a72', ground: '#10241d', light: '#f4dc8f', glow: '#ffd98a', risen: .62, stars: .35 },
    moonrise: { top: '#050820', bottom: '#2f3f92', ground: '#0e1330', light: '#eef0ff', glow: '#b9c4ff', risen: .78, stars: 1 }
};

const page = ({ top, bottom, ground, light, glow, risen, stars }) => `<!doctype html><html><head><style>
@font-face { font-family: B; src: url(data:font/woff2;base64,${font}) format('woff2'); font-weight: 200 800; }
* { margin: 0; }
body { width: 1120px; height: 520px; overflow: hidden; background: ${ground}; }
.sky { position: absolute; inset: 0 0 56px; overflow: hidden; background: linear-gradient(${top}, ${bottom}); }
.sky::after { content: ''; position: absolute; inset: 0; opacity: .22; mix-blend-mode: soft-light; background: ${grain}; }
.pool { position: absolute; inset: 0; background: radial-gradient(42% 85% at 82% 100%, ${glow}aa, transparent 70%); }
.stars { position: absolute; inset: 0 0 30%; opacity: ${stars}; background:
  radial-gradient(2px 2px at 8% 14%, #fff, transparent), radial-gradient(1.5px 1.5px at 19% 36%, #fff, transparent), radial-gradient(2.5px 2.5px at 33% 9%, #fff, transparent),
  radial-gradient(1.5px 1.5px at 48% 28%, #fff, transparent), radial-gradient(2px 2px at 71% 12%, #fff, transparent), radial-gradient(1.5px 1.5px at 84% 33%, #fff, transparent),
  radial-gradient(2px 2px at 93% 8%, #fff, transparent), radial-gradient(1.5px 1.5px at 58% 47%, #fff, transparent), radial-gradient(1px 1px at 27% 58%, #fff, transparent),
  radial-gradient(1.5px 1.5px at 89% 55%, #fff, transparent), radial-gradient(1px 1px at 40% 70%, #fff, transparent); }
.word { position: absolute; z-index: 1; left: 64px; bottom: 0; display: flex; align-items: baseline; color: ${ground};
  font: 800 420px/0.74 B; font-stretch: 78%; font-variation-settings: 'wdth' 78; letter-spacing: -.05em; margin-bottom: -.043em; }
.word i { position: relative; z-index: -1; width: .3em; aspect-ratio: 1; margin-left: -.09em; border-radius: 50%; translate: 0 ${(1 - risen) * 100}%;
  background: radial-gradient(circle at 50% 46%, color-mix(in oklab, ${light} 45%, white), ${light} 58%, color-mix(in oklab, ${light} 82%, ${bottom}));
  box-shadow: 0 0 .03em ${light}, 0 0 .12em ${light}88, 0 0 .45em ${glow}55; }
.clip { position: absolute; inset: 0 0 56px; overflow: hidden; }
</style></head><body>
<div class="sky"><div class="pool"></div><div class="stars"></div></div>
<div class="clip"><div class="word">flow<i></i></div></div>
</body></html>`;

(async () => {
    mkdirSync(OUT, { recursive: true });
    const browser = await chromium.launch();
    const tab = await browser.newPage({ viewport: { width: 1120, height: 520 } });
    for (const [name, scene] of Object.entries(scenes)) {
        await tab.setContent(page(scene));
        await tab.evaluate(() => document.fonts.ready);
        await tab.screenshot({ path: resolve(OUT, name + '.jpg'), type: 'jpeg', quality: 84 });
    }
    await browser.close();
    console.log('Wrote', Object.keys(scenes).map(name => `public/email/${name}.jpg`).join(', '));
})();

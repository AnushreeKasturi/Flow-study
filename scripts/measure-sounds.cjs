// Dev tool: records each soundscape for a few seconds in headless Chromium and prints how its
// energy splits across low, mid and high bands, plus sharp clicks per second, loudness and peak.
// WAVs land in output/sound/. Usage: node scripts/measure-sounds.cjs [label]
const { chromium } = require('playwright');
const { build } = require('esbuild');
const fs = require('fs');
const tag = process.argv[2] || 'now';
fs.mkdirSync('output/sound', { recursive: true });
(async () => {
  const bundle = await build({ entryPoints: ['src/client/modules/soundscape.ts'], bundle: true, write: false, format: 'esm' });
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  await page.route('http://sound.test/*', r => new URL(r.request().url()).pathname.endsWith('.js')
    ? r.fulfill({ body: bundle.outputFiles[0].text, contentType: 'text/javascript' })
    : r.fulfill({ body: '<!doctype html><title>s</title>', contentType: 'text/html' }));
  await page.goto('http://sound.test/');
  for (const scene of ['fire', 'rain', 'ocean', 'wind', 'night']) {
    const result = await page.evaluate(async scene => {
      const s = await import('/s.js?' + scene);
      const native = AudioNode.prototype.connect;
      let tap;
      AudioNode.prototype.connect = function (dest, ...rest) {
        if (dest instanceof AudioDestinationNode) {
          const ctx = this.context;
          tap = ctx.createScriptProcessor(4096, 1, 1);
          tap.samples = [];
          tap.onaudioprocess = e => tap.samples.push(new Float32Array(e.inputBuffer.getChannelData(0)));
          native.call(this, tap); native.call(tap, ctx.destination);
        }
        return native.call(this, dest, ...rest);
      };
      s.setSoundVolume(1);
      s.playSound(scene);
      await new Promise(r => setTimeout(r, 7000));
      s.stopSound();
      AudioNode.prototype.connect = native;
      const rate = tap.context.sampleRate;
      const all = new Float32Array(tap.samples.reduce((n, b) => n + b.length, 0));
      let o = 0; for (const b of tap.samples) { all.set(b, o); o += b.length; }
      const x = all.subarray(rate * 1.5, rate * 6.5); // skip the fade-in
      // Energy split by one-pole filters: below 250 Hz, 250 Hz to 2 kHz, above 2 kHz.
      const lp = (sig, fc) => { const a = Math.exp(-2 * Math.PI * fc / rate); const y = new Float32Array(sig.length); let p = 0; for (let i = 0; i < sig.length; i++) y[i] = p = (1 - a) * sig[i] + a * p; return y; };
      const low = lp(x, 250), belowHigh = lp(x, 2000);
      let eL = 0, eM = 0, eH = 0;
      const high = new Float32Array(x.length);
      for (let i = 0; i < x.length; i++) { eL += low[i] ** 2; eM += (belowHigh[i] - low[i]) ** 2; high[i] = x[i] - belowHigh[i]; eH += high[i] ** 2; }
      const total = eL + eM + eH;
      // Clicks: 1 ms windows of the high band whose peak is 6x its typical level.
      let rms = Math.sqrt(eH / x.length), clicks = 0, inClick = false;
      for (let i = 0; i < x.length; i += Math.round(rate / 1000)) {
        let peak = 0; for (let j = i; j < i + rate / 1000 && j < x.length; j++) peak = Math.max(peak, Math.abs(high[j]));
        const hit = peak > 6 * rms; if (hit && !inClick) clicks++; inClick = hit;
      }
      // 16-bit WAV of the five measured seconds.
      const pcm = new DataView(new ArrayBuffer(44 + x.length * 2));
      const w = (o, str) => [...str].forEach((c, i) => pcm.setUint8(o + i, c.charCodeAt(0)));
      w(0, 'RIFF'); pcm.setUint32(4, 36 + x.length * 2, true); w(8, 'WAVEfmt '); pcm.setUint32(16, 16, true); pcm.setUint16(20, 1, true); pcm.setUint16(22, 1, true);
      pcm.setUint32(24, rate, true); pcm.setUint32(28, rate * 2, true); pcm.setUint16(32, 2, true); pcm.setUint16(34, 16, true); w(36, 'data'); pcm.setUint32(40, x.length * 2, true);
      let peakAll = 0; for (const v of x) peakAll = Math.max(peakAll, Math.abs(v));
      for (let i = 0; i < x.length; i++) pcm.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x[i] / Math.max(peakAll, 1e-6) * .9)) * 32767, true);
      let bin = ''; const bytes = new Uint8Array(pcm.buffer); for (let i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode(...bytes.subarray(i, i + 32768));
      return { low: +(eL / total * 100).toFixed(1), mid: +(eM / total * 100).toFixed(1), high: +(eH / total * 100).toFixed(1), clicksPerSec: +(clicks / 5).toFixed(1), level: +Math.sqrt(total / x.length).toFixed(3), peak: +peakAll.toFixed(2), wav: btoa(bin) };
    }, scene);
    fs.writeFileSync(`output/sound/${tag}-${scene}.wav`, Buffer.from(result.wav, 'base64'));
    delete result.wav;
    console.log(tag.padEnd(6), scene.padEnd(6), JSON.stringify(result));
  }
  await browser.close();
})();

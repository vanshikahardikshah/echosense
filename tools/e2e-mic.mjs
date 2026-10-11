// End-to-end: a rendered room recording replaces the microphone in Chromium.
// Exercises getUserMedia -> AudioWorklet -> engine worker -> fusion -> UI.
//   node tools/e2e-mic.mjs <scene.wav> <outdir> [seconds]
import { chromium } from 'playwright-core';
const [wav, out, seconds = '78'] = process.argv.slice(2);
const exe = process.env.CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({
  executablePath: exe,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}%noloop`, '--autoplay-policy=no-user-gesture-required'],
});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ['microphone'] });
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto('http://localhost:8080/');
await page.click('#start');
const t0 = Date.now();
let shotAlert = false;
while ((Date.now() - t0) / 1000 < Number(seconds)) {
  await page.waitForTimeout(4000);
  const s = await page.evaluate(() => {
    const e = window.__echosense;
    const sn = e.snapshot;
    return sn
      ? { t: +sn.t.toFixed(1), phase: sn.sonarPhase, status: sn.fusion.status, head: sn.fusion.headline, link: +sn.sonar.linkSnrDb.toFixed(1), ms: +sn.perf.msPerFrame.toFixed(2), alerts: e.alerts.length }
      : null;
  });
  console.log(JSON.stringify(s));
  if (s && s.status === 'alert' && !shotAlert) {
    shotAlert = true;
    await page.screenshot({ path: `${out}/e2e-alert.png` });
  }
}
const alerts = await page.evaluate(() => window.__echosense.alerts.map((a) => `${a.t.toFixed(1)}s ${a.severity} ${a.title} (${a.confidence.toFixed(2)})`).reverse());
console.log('ALERTS\n' + alerts.join('\n'));
await page.screenshot({ path: `${out}/e2e-final.png` });
console.log(logs.filter((l) => !l.includes('DevTools')).slice(0, 20).join('\n'));
await browser.close();

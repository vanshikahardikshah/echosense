// Checks that the sound model loads in a browser and labels the fake microphone stream.
import { chromium } from 'playwright-core';
const [wav, seconds = '30'] = process.argv.slice(2);
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}%noloop`, '--autoplay-policy=no-user-gesture-required'],
});
const page = await (await browser.newContext({ permissions: ['microphone'] })).newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto('http://localhost:8080/' + (process.env.Q ?? ''));
await page.click('#start');
const t0 = Date.now();
while ((Date.now() - t0) / 1000 < Number(seconds)) {
  await page.waitForTimeout(3000);
  const s = await page.evaluate(() => { const e = window.__echosense; return { t: e.snapshot?.t?.toFixed(1), ai: e.ai.status, last: e.ai.frames.map((f) => `${f.t.toFixed(1)}:${f.top.map((x) => x.name + ' ' + x.score).join('/')}`) }; });
  console.log(JSON.stringify(s));
}
console.log((await page.evaluate(() => window.__echosense.alerts.map((a) => `${a.t.toFixed(1)} ${a.title} | ${a.evidence.join(' ; ')}`))).join('\n'));
await browser.close();

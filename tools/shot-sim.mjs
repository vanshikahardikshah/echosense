// Screenshot the phone app (simulation mode) and the console.
import { chromium } from 'playwright-core';
const out = process.argv[2] ?? '.';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto('http://localhost:8080/');
await page.screenshot({ path: `${out}/01-onboard.png` });
await page.click('#start-sim');
const waits = [[10, '02-calibrating-walkin'], [24, '03-sitting-breathing'], [50, '04-fall-checkin']];
let t = 0;
for (const [at, name] of waits) {
  await page.waitForTimeout((at - t) * 1000);
  t = at;
  await page.screenshot({ path: `${out}/${name}.png` });
  const s = await page.evaluate(() => { const e = window.__echosense; const sn = e.snapshot; return sn ? { t: sn.t.toFixed(1), status: sn.fusion.status, headline: sn.fusion.headline, sub: sn.fusion.subline, alerts: e.alerts.map(a => a.title) } : null; });
  console.log(name, JSON.stringify(s));
}
await page.click('#ci-ok').catch(() => {});
await page.waitForTimeout(1500);
await page.click('[data-tab=signals]');
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/05-signals.png`, fullPage: true });
await page.click('[data-tab=room]');
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/06-room-after.png`, fullPage: true });
const desk = await browser.newPage({ viewport: { width: 1360, height: 900 } });
await desk.goto('http://localhost:8080/console');
await desk.waitForTimeout(2500);
await desk.screenshot({ path: `${out}/07-console.png` });
console.log(logs.slice(0, 30).join('\n'));
await browser.close();

import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage({ viewport: { width: 1360, height: 950 } });
await p.goto('http://localhost:8090/console');
await p.waitForTimeout(600);
await p.click('#w-eval');
await p.waitForTimeout(4000);
await p.screenshot({ path: process.argv[2] });
await b.close();

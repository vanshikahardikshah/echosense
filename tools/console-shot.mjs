import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage({ viewport: { width: 1360, height: 900 } });
await p.goto('http://localhost:8080/console');
await p.waitForTimeout(6000);
await p.screenshot({ path: process.argv[2] });
await b.close();

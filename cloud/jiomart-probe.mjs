// Honest reachability test from GitHub's servers: an ordinary (non-headless, undisguised) Chrome visits JioMart.
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-IN', timezoneId: 'Asia/Kolkata' });
const page = await ctx.newPage();
const resp = await page.goto('https://www.jiomart.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) => ({ status: () => 'ERR ' + e.message.slice(0, 80) }));
await page.waitForTimeout(5000);
const text = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
console.log('HOME status:', resp.status());
console.log('HOME text:', text.slice(0, 200));
const r2 = await page.goto('https://www.jiomart.com/products?q=Google+Fitbit+Air', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) => ({ status: () => 'ERR ' + e.message.slice(0, 80) }));
await page.waitForTimeout(6000);
const t2 = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
console.log('SEARCH status:', r2.status());
console.log('SEARCH text:', t2.slice(0, 200));
console.log('BLOCKED:', /access denied/i.test(text + t2));
await browser.close();

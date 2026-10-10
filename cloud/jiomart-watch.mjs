// Runs inside GitHub Actions (under xvfb, as an ordinary non-headless Chrome). Sets the delivery PIN through JioMart's own
// location picker, then reads the product list the page receives and pushes to your phone (ntfy) if the target appears.
// No login, no cart, no purchase. The PIN comes from the JIOMART_PIN secret (it is not stored in this public repo).
import fs from 'node:fs';
import { chromium } from 'playwright';

const cfg = JSON.parse(fs.readFileSync(new URL('jiomart-config.json', import.meta.url)));
const { NTFY_TOPIC: topic, JIOMART_PIN: PIN } = process.env;
if (!topic || !PIN) { console.error('NTFY_TOPIC / JIOMART_PIN secret missing'); process.exit(1); }

const MATCH = new RegExp(cfg.match, 'i');
const SEARCH = `https://www.jiomart.com/products?q=${cfg.query.trim().split(/\s+/).map(encodeURIComponent).join('+')}`;
const productUrl = (slug) => `https://www.jiomart.com/product/${slug}`;
const push = (title, msg, { url, priority = 'urgent', tags = 'rotating_light' } = {}) =>
  fetch(`https://ntfy.sh/${topic}`, { method: 'POST', body: msg, headers: { Title: title, Priority: priority, Tags: tags, ...(url ? { Click: url } : {}) }, signal: AbortSignal.timeout(8000) }).catch(() => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const startedAt = new Date();
const END = Date.now() + cfg.runMinutes * 60_000;
const halfHourSlot = startedAt.getUTCMinutes() % 30 < 14;
const hourSlot = startedAt.getUTCMinutes() < 14;

// Pure classifier over the product list JioMart returned for the selected PIN (it only returns deliverable items).
function classify(items) {
  const price = (i) => i.price?.effective?.min ?? i.price?.min ?? 0;
  const trackers = (items || []).filter((i) => /fitbit\s*air/i.test(i.name || '') && /google/i.test(i.name || '') && price(i) >= cfg.minPrice);
  const hit = trackers.find((i) => MATCH.test(i.name));
  const names = trackers.map((i) => `${i.name} (₹${price(i)}${i.sellable ? '' : ', unavailable'})`);
  if (hit) return { state: hit.sellable && hit.availability !== 0 ? 'in_stock' : 'listed_unavailable', item: hit, names };
  return { state: 'not_listed', names, others: trackers.filter((i) => i.sellable) };
}

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-IN', timezoneId: 'Asia/Kolkata', geolocation: { latitude: 12.9299, longitude: 77.6784 }, permissions: ['geolocation'] });
const page = await ctx.newPage();

let lastSearchHeaders = {};
page.on('request', (r) => { if (r.url().includes('/ext/vertex/application/api/v1.0/products?') && /[?&]q=/.test(r.url())) lastSearchHeaders = r.headers(); });

// Same steps a person would do: open the location picker, type the PIN, pick the suggestion, confirm, choose "Shop all".
async function setLocation() {
  await page.goto('https://www.jiomart.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await sleep(3000);
  const manual = page.getByRole('button', { name: /select location manually/i });
  if (await manual.isVisible({ timeout: 4000 }).catch(() => false)) await manual.click();
  else await page.getByText(/^Location$/).first().click({ timeout: 5000 });
  const box = page.getByPlaceholder(/search for area/i).first();
  await box.waitFor({ timeout: 10_000 });
  await box.click();
  await page.keyboard.type(PIN, { delay: 80 });
  const suggestion = page.locator('.pac-item, [class*="pac-item"]').filter({ hasText: PIN }).first();
  await suggestion.waitFor({ timeout: 10_000 });
  await suggestion.click();
  await page.getByText(/delivering your order to/i).first().waitFor({ timeout: 12_000 });
  await sleep(4000);
  await page.getByRole('button', { name: /confirm location/i }).click({ timeout: 10_000 });
  await sleep(5000);
  await page.getByText(/^Shop all$/i).first().click({ timeout: 6000 }).catch(() => {});
  await sleep(2000);
}

// The location JioMart actually used for the search must be the Bengaluru PIN, never the datacenter-IP default (Mumbai).
const locationOk = () => {
  const h = lastSearchHeaders;
  let pinOk = false, geoOk = false;
  try { pinOk = String(JSON.parse(h['x-location-detail'] || '{}').pincode) === PIN; } catch {}
  try { const g = JSON.parse(h['x-geolocation'] || '{}'); geoOk = +g.latitude > 12.7 && +g.latitude < 13.3 && +g.longitude > 77.3 && +g.longitude < 77.9; } catch {}
  return pinOk && geoOk;
};

const isStd = (r) => { const u = decodeURIComponent(r.url()); return u.includes('/ext/vertex/application/api/v1.0/products?') && u.includes('journey:standard') && /[?&]q=/.test(u); };
async function readListing(first) {
  const wait = page.waitForResponse(isStd, { timeout: 25_000 });
  if (first) await page.goto(SEARCH, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  else await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 });
  const r = await wait;
  if (r.status() === 403) return { state: 'blocked' };
  if (r.status() !== 200) return { state: 'unknown', status: r.status() };
  if (!locationOk()) return { state: 'wrong_location' };
  return classify((await r.json()).items);
}
async function check(first) {
  const a = await readListing(first);
  if (a.state !== 'in_stock') return a;
  for (let i = 0; i < 2; i++) { await sleep(800); if ((await readListing(false)).state !== 'in_stock') return { state: 'unknown' }; }  // 3 consecutive reads
  return a;
}

let polls = 0, readable = 0, wrong = 0, alerted = false, seen = new Set();
try {
  await setLocation();
} catch (e) {
  console.log('location setup failed:', e.message.split('\n')[0]);
}
for (let first = true; Date.now() < END; first = false) {
  let r;
  try { r = await check(first); } catch (e) { r = { state: 'unknown', error: e.message.split('\n')[0] }; }
  polls++;
  console.log(new Date().toISOString(), r.state, (r.names || []).join('; '), r.error || '');
  if (r.state === 'not_listed' || r.state === 'listed_unavailable' || r.state === 'in_stock') readable++;
  if (r.state === 'wrong_location') wrong++;
  if (r.state === 'in_stock' && !alerted) {
    alerted = true;
    await push('RESTOCK: Google Fitbit Air OBSIDIAN is IN STOCK (JioMart)', `${r.item.name} - ₹${r.item.price?.effective?.min ?? ''}. Deliverable to your PIN. Tap to open JioMart and buy NOW.`, { url: productUrl(r.item.slug) });
  }
  for (const o of r.others ?? []) if (!/lavender/i.test(o.name) && !seen.has(o.name)) { seen.add(o.name); await push('FYI: new Fitbit Air listing on JioMart', `${o.name} is now listed (not Obsidian).`, { url: productUrl(o.slug), priority: 'default', tags: 'information_source' }); }
  if (r.state === 'blocked') { console.log('JioMart is denying this runner'); break; }
  if (wrong >= 3 && readable === 0) { console.log('location could not be set to the PIN'); break; }
  await sleep(cfg.pollSeconds[0] * 1000 + Math.random() * (cfg.pollSeconds[1] - cfg.pollSeconds[0]) * 1000);
}
await browser.close();

// Status pings, at most once per window so a back-to-back chain does not spam you.
if (readable === 0 && halfHourSlot) await push('Cloud JioMart watcher cannot read JioMart', 'No readable, correctly-located JioMart page this run (blocked, wrong city, or layout change). The Mac watcher is the only one checking.', { priority: 'high' });
if (readable > 0 && hourSlot && startedAt.getUTCHours() % 3 === 0) await push('Cloud JioMart watcher alive', 'GitHub JioMart watcher is running with the right location. Obsidian not available yet.', { priority: 'default', tags: 'eyes' });

// Start the next run right away (the workflow's concurrency group queues it behind this one).
if (process.env.GH_TOKEN && process.env.GITHUB_REPOSITORY) {
  await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/jiomart-watch.yml/dispatches`, {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' }, body: JSON.stringify({ ref: process.env.GITHUB_REF_NAME || 'main' }),
  }).then((r) => console.log('dispatched next run:', r.status)).catch((e) => console.log('dispatch failed', e.message));
}

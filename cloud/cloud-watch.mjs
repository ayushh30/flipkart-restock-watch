// Runs inside GitHub Actions. Polls for ~4.5 min, pushes to your phone via ntfy on restock.
import fs from 'node:fs';
const config = JSON.parse(fs.readFileSync(new URL('cloud-config.json', import.meta.url)));
const topic = process.env.NTFY_TOPIC;
if (!topic) { console.error('NTFY_TOPIC secret missing'); process.exit(1); }
const H = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 'accept-language': 'en-IN,en;q=0.9' };
const url = (s) => `https://www.flipkart.com/${config.product.slug}/p/${s.itm}?pid=${s.pid}&lid=${s.lid}&marketplace=FLIPKART`;
const push = (title, msg, click) => fetch(`https://ntfy.sh/${topic}`, { method: 'POST', body: msg, headers: { Title: title, Priority: 'urgent', Tags: 'rotating_light', ...(click ? { Click: click } : {}) } }).catch(() => {});

const count = (h, n) => h.split(n).length - 1;
// Verified on live pages: a real sold-out page has "Notify Me"; a real purchasable page has BUY_NOW x11+ and "Buy at" x5.
// Flipkart sometimes serves a degraded ~390KB shell with NO widgets (so also no "Notify Me") - that must never count as stock.
function classify(t, pid, colour) {
  if (!t.includes(pid)) return "unknown";
  const full = count(t, "ATLAS_SWATCH_ATTRIBUTE") >= 100 && t.includes("Select Size") && t.includes(colour);
  if (!full) return "unknown";
  if (count(t, "Notify Me") > 0) return "out";
  return count(t, "BUY_NOW") >= 5 && count(t, "Buy at") >= 3 ? "in" : "unknown";
}
async function once(s) {
  const r = await fetch(url(s), { headers: H, signal: AbortSignal.timeout(10000) });
  const t = await r.text();
  if (r.status >= 400 || t.length < 200000) return "blocked";
  return classify(t, s.pid, s.colour);
}
// "in" must be reproduced by 3 consecutive reads before it is reported.
async function check(s) {
  try {
    const first = await once(s);
    if (first !== "in") return first;
    for (let i = 0; i < 2; i++) { await new Promise((r) => setTimeout(r, 350)); if ((await once(s)) !== "in") return "unknown"; }
    return "in";
  } catch { return "unknown"; }
}

const end = Date.now() + 270_000;
let blocked = 0, polls = 0, readable = 0, blockedPushed = false, alerted = new Set();
const startedAt = new Date();
const halfHourSlot = startedAt.getUTCMinutes() % 30 < 5;  // true for runs starting in the first 5 min of each half hour
const hourSlot = startedAt.getUTCMinutes() < 5;
while (Date.now() < end) {
  const res = await Promise.all(config.sizes.map(async (s) => [s, await check(s)]));
  polls++;
  console.log(new Date().toISOString(), res.map(([s, st]) => `${s.id}:${st}`).join(' '));
  const nowIn = res.filter(([, st]) => st === 'in').map(([s]) => s);
  for (const s of nowIn) if (!alerted.has(s.id)) {
    alerted.add(s.id);
    const others = nowIn.filter((o) => o.id !== s.id).map((o) => o.label);
    await push(`RESTOCK: ${s.label} IN STOCK${others.length ? ' (BOTH COLOURS!)' : ''}`, `${config.product.name} - ${s.label}.${others.length ? ' ALSO IN STOCK: ' + others.join(' + ') + '.' : ''} Tap to open Flipkart and buy NOW.`, url(s));
  }
  if (res.some(([, st]) => st === 'out' || st === 'in')) readable++;
  if (res.every(([, st]) => st === 'blocked')) {
    if (++blocked >= 5) {
      // Don't end the run early (that would chain into a rapid retry loop): idle out the rest of this run.
      console.log('Flipkart is blocking this runner; idling until the end of this run');
      if (!blockedPushed && halfHourSlot) { blockedPushed = true; await push('Cloud watcher blocked', 'Flipkart is blocking GitHub servers. Only the Mac watcher is checking.'); }
      await new Promise((r) => setTimeout(r, Math.max(0, end - Date.now())));
      break;
    }
  } else blocked = 0;
  await new Promise((r) => setTimeout(r, 3000 + Math.random() * 2000));
}

// Status pings, at most once per window so a 5-minute chain does not spam you.
if (readable === 0 && polls > 0 && halfHourSlot && !blockedPushed) await push('Cloud watcher cannot read Flipkart', 'No readable product page this run. Check stock manually.');
if (hourSlot && startedAt.getUTCHours() % 3 === 0) await push('Cloud watcher alive', 'GitHub watcher is running and reading Flipkart. Nothing in stock yet.');

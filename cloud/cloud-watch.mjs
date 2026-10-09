// Runs inside GitHub Actions. Polls for ~4.5 min, pushes to your phone via ntfy on restock.
import fs from 'node:fs';
const config = JSON.parse(fs.readFileSync(new URL('cloud-config.json', import.meta.url)));
const topic = process.env.NTFY_TOPIC;
if (!topic) { console.error('NTFY_TOPIC secret missing'); process.exit(1); }
const H = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 'accept-language': 'en-IN,en;q=0.9' };
const url = (s) => `https://www.flipkart.com/${config.product.slug}/p/${config.product.itm}?pid=${s.pid}&lid=${s.lid}&marketplace=FLIPKART`;
const push = (title, msg, click) => fetch(`https://ntfy.sh/${topic}`, { method: 'POST', body: msg, headers: { Title: title, Priority: 'urgent', Tags: 'rotating_light', ...(click ? { Click: click } : {}) } }).catch(() => {});

async function check(s) {
  try {
    const r = await fetch(url(s), { headers: H, signal: AbortSignal.timeout(10000) });
    const t = await r.text();
    if (r.status >= 400 || t.length < 200000) return 'blocked';
    if (/Notify Me/.test(t)) return 'out';
    return /Buy Now|Add to cart/i.test(t) ? 'in' : 'unknown';
  } catch { return 'unknown'; }
}

const end = Date.now() + 270_000;
let blocked = 0, polls = 0, alerted = new Set();
while (Date.now() < end) {
  const res = await Promise.all(config.sizes.map(async (s) => [s, await check(s)]));
  polls++;
  console.log(new Date().toISOString(), res.map(([s, st]) => `${s.size}:${st}`).join(' '));
  for (const [s, st] of res) if (st === 'in' && !alerted.has(s.size)) { alerted.add(s.size); await push(`RESTOCK: NB 530 size ${s.size} is IN STOCK`, `New Balance 530 WHITE 0SG, size ${s.size}. Tap to open Flipkart and buy NOW.`, url(s)); }
  if (res.every(([, st]) => st === 'blocked')) { if (++blocked >= 5) { console.log('Flipkart is blocking this runner'); if (polls === blocked) await push('Cloud watcher blocked', 'Flipkart blocked GitHub servers. Rely on the Mac watcher.'); break; } } else blocked = 0;
  await new Promise((r) => setTimeout(r, 3000 + Math.random() * 2000));
}

#!/usr/bin/env node
// CESR (Composite Ether Staking Rate) daily history → data/cesr.json.
// Source: the public JSON behind quatrefoildata.com's CESR chart (Quatrefoil Data Services administers CESR; CoinDesk
// Indices calculates it). No key. One value per calendar day: the annualized mean yield of all eligible Ethereum
// validators (consensus rewards + priority fees) over the one-day observation period ending 13:05 ET on that date,
// published 16:00 ET. The build averages the daily total_rate over each release window as an independent check on
// Bitmine's stated 7-day yield (and uses it only for weeks with no stated yield).
// Usage: node scripts/fetch-cesr.mjs
import { writeFile } from 'node:fs/promises';

const URL_ = 'https://cdn.quatrefoildata.com/cesr/data.json';
const OUT = new URL('../data/cesr.json', import.meta.url);
const FROM = '2025-11-01';
let res;
for (let i = 0; i < 3; i++) {
  res = await fetch(URL_, { headers: { 'User-Agent': 'Mozilla/5.0 (bmnr-nav-tracker)' } }).catch((e) => ({ ok: false, statusText: e.message }));
  if (res.ok) break;
  await new Promise((s) => setTimeout(s, 3000 * (i + 1)));
}
if (!res.ok) { console.error(`CESR fetch failed: ${res.status ?? ''} ${res.statusText}`); process.exit(1); }
const raw = await res.json();
const days = raw.filter((x) => x.date >= FROM).sort((a, b) => a.date.localeCompare(b.date))
  .map((x) => ({ date: x.date, total_rate: +(+x.total_rate).toFixed(8), consensus_rewards_rate: +(+x.consensus_rewards_rate).toFixed(8), block_rewards_rate: +(+x.block_rewards_rate).toFixed(8) }));
if (!days.length || days.some((d) => !(d.total_rate > 0 && d.total_rate < 0.5))) { console.error('CESR data failed sanity check'); process.exit(1); }
const out = {
  description: 'CESR® (Composite Ether Staking Rate) daily values since Nov 1, 2025: mean annualized yield of all eligible Ethereum validators (consensus rewards + priority transaction fees), one-day observation period ending 13:05 ET on each date. Independent check on Bitmine\'s stated 7-day yield; weekly value = average of the daily total_rate within each release window (previous as-of + 1 day … as-of).',
  source: { url: URL_, page: 'https://www.quatrefoildata.com/methodology?rate=cesr', administrator: 'Quatrefoil Data Services (QDS)', calculation_agent: 'CoinDesk Indices', index_page: 'https://indices.coindesk.com/indices/cesr-composite-ether-staking-rate', script: 'node scripts/fetch-cesr.mjs' },
  fetched: new Date().toISOString(), source_last_modified: res.headers.get('last-modified'), days,
};
await writeFile(OUT, JSON.stringify(out, null, 1) + '\n');
console.log(`wrote ${days.length} CESR days (${days[0].date} … ${days.at(-1).date}) to data/cesr.json; latest ${(days.at(-1).total_rate * 100).toFixed(3)}%`);

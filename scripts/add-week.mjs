#!/usr/bin/env node
// Weekly update: append Bitmine's Monday release to data/releases.json, then rebuild history/holdings
// with scripts/build-history.mjs (share-count reconstruction from the cash-flow identity).
//
//   node scripts/add-week.mjs --date 2026-11-02 --asof 2026-11-01 \
//     --eth 6060000 --acquired 8067 --eth-price 2400 --staked 5227037 --yield 0.0258 \
//     --btc 215 --cash 480000000 --orbs-value 75000000 --beast 180000000 \
//     [--buyback-shares 1000000 --buyback-price 22.10] [--other-shares 0] \
//     [--investments USD] [--shares-issued N] [--proceeds USD] \
//     [--shares-outstanding N --cp-date YYYY-MM-DD --cp-source "10-K cover page" --cp-url "<filing URL>"] \
//     --sec "<8-K Ex.99.1 URL>" [--x "<@BitMNR post URL>"] [--pr "<PR Newswire URL>"] [--notes "..."] [--dry]
//
// --investments  = cash spent that week on non-ETH investments disclosed in the release (stakes, acquisitions)
// --proceeds     = disclosed NON-common financing (e.g. preferred stock); --shares-issued = disclosed ATM shares
// --shares-outstanding adds an official checkpoint to data/checkpoints.json (the estimate re-anchors there).
// Also update data/releases.json → buyback_aggregate when a release states a new cumulative buyback total.
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const F = new URL('../data/releases.json', import.meta.url);
const CF = new URL('../data/checkpoints.json', import.meta.url);
const a = {};
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i];
  if (!k.startsWith('--')) continue;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) a[k.slice(2)] = true; else { a[k.slice(2)] = v; i++; }
}
const num = (k) => (a[k] === undefined ? null : Number(String(a[k]).replace(/[,_$]/g, '')));
const need = ['date', 'asof', 'eth', 'acquired', 'eth-price', 'staked', 'yield', 'btc', 'cash', 'orbs-value', 'sec'];
const miss = need.filter((k) => a[k] === undefined);
if (miss.length) { console.error('missing: --' + miss.join(', --')); process.exit(1); }

const R = JSON.parse(await readFile(F, 'utf8'));
const prev = R.releases.at(-1);
if (R.releases.some((x) => x.as_of === a.asof) && !a.force) { console.error(`release for ${a.asof} exists (use --force)`); process.exit(1); }
const entry = {
  date: a.date, as_of: a.asof, eth: num('eth'), eth_acquired_reported: num('acquired'), eth_price_reported: num('eth-price'),
  btc: num('btc'), cash_usd: num('cash'), orbs_value_usd: num('orbs-value'), beast_usd: num('beast') ?? prev.beast_usd,
  eth_staked: num('staked'), staking_yield_7d: num('yield'),
  buyback_shares: num('buyback-shares') ?? 0, buyback_price: num('buyback-price'), other_shares_issued: num('other-shares') ?? 0,
  disclosed_shares_issued: num('shares-issued'), disclosed_proceeds_usd: num('proceeds'), investments_usd: num('investments') ?? 0,
  shares_outstanding_official: null,
  sec_8k: a.sec, x_post: a.x || null, press_release: a.pr || null, notes: a.notes || '',
};
if (entry.eth - prev.eth !== entry.eth_acquired_reported) console.warn(`note: holdings change ${entry.eth - prev.eth} ≠ reported acquired ${entry.eth_acquired_reported}`);
R.releases = R.releases.filter((x) => x.as_of !== a.asof).concat(entry).sort((x, y) => x.as_of.localeCompare(y.as_of));
if (a.dry) { console.log(JSON.stringify(entry, null, 2)); process.exit(0); }
await writeFile(F, JSON.stringify(R, null, 2) + '\n');
if (a['shares-outstanding'] !== undefined) {
  const C = JSON.parse(await readFile(CF, 'utf8'));
  const cp = { date: a['cp-date'] || a.asof, shares: num('shares-outstanding'), basis: a['cp-source'] || 'official filing', source: a['cp-source'] || 'official filing', url: a['cp-url'] || a.sec, use_as_anchor: true };
  C.checkpoints = C.checkpoints.filter((c) => c.date !== cp.date).concat(cp).sort((x, y) => x.date.localeCompare(y.date));
  await writeFile(CF, JSON.stringify(C, null, 2) + '\n');
  console.log('added checkpoint', cp);
}
const res = spawnSync(process.execPath, [new URL('./build-history.mjs', import.meta.url).pathname], { stdio: 'inherit' });
process.exit(res.status);

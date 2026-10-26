#!/usr/bin/env node
// Weekly update helper: turns Bitmine's Monday holdings announcement into a history snapshot
// and refreshes data/holdings.json, applying the tracker's documented assumptions.
//
// Example (Oct 26, 2026 announcement):
//   node scripts/add-week.mjs --date 2026-10-26 --asof 2026-10-25 \
//     --eth 6051933 --staked 5227037 --btc 215 --cash 514000000 --orbs-value 76000000 \
//     --beast 180000000 --buyback-shares 2040000 --buyback-price 22.48 --pr-eth-price 2356 \
//     --source "https://www.prnewswire.co.uk/..." --x "https://x.com/BitMNR/status/..." --notes "..."
//
// Optional overrides (use when Bitmine discloses them): --purchase-price, --shares-issued,
// --shares-outstanding (official count; replaces the running estimate), --staking-yield (the release's
// stated 7-day BMNR yield, e.g. 0.0258), --sec (SEC 8-K URL).
// Add --dry to print without writing.
import { readFile, writeFile } from 'node:fs/promises';
import { computeNav, weeklyStakingEth } from '../assets/calc.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';
const H = new URL('../data/holdings.json', import.meta.url);
const HIST = new URL('../data/history.json', import.meta.url);

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const k = a.slice(2);
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) args[k] = true; else { args[k] = v; i++; }
}
const num = (k, d) => (args[k] === undefined ? d : Number(String(args[k]).replace(/[,_$]/g, '')));
for (const k of ['date', 'asof', 'eth', 'staked', 'btc', 'cash', 'source']) {
  if (args[k] === undefined) { console.error(`missing --${k}`); process.exit(1); }
}

const holdings = JSON.parse(await readFile(H, 'utf8'));
const history = JSON.parse(await readFile(HIST, 'utf8'));
if (history.snapshots.some((s) => s.date === args.date) && !args.force) {
  console.error(`snapshot ${args.date} already exists (use --force to replace)`); process.exit(1);
}

const day = 86400000;
const asof = Date.parse(args.asof + 'T00:00:00Z');
const winStart = asof - 6 * day;           // Mon..Sun week ending on the "as of" date
const winEnd = asof + day;                 // inclusive of the as-of day

async function getJSON(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}
async function cgDaily(id) {
  const j = await getJSON(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=120&interval=daily`);
  return j.prices; // [ms, price] at 00:00 UTC
}
async function yahooDaily(sym) {
  const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=6mo`);
  const r = j.chart.result[0];
  return r.timestamp.map((t, i) => [t * 1000, r.indicators.quote[0].close[i]]).filter((p) => p[1] != null);
}
const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;

const [eth, btc, bmnr, orbs] = await Promise.all([cgDaily('ethereum'), cgDaily('bitcoin'), yahooDaily('BMNR'), yahooDaily('ORBS')]);
// CoinGecko daily point at D 00:00 UTC ≈ close of D-1, so window is (winStart, winEnd].
const ethWeek = eth.filter(([t]) => t > winStart && t <= winEnd).map((p) => p[1]);
const bmnrWeek = bmnr.filter(([t]) => t >= winStart && t < winEnd).map((p) => p[1]);
const lastOnOrBefore = (series, t) => { let v = null; for (const [ts, p] of series) if (ts <= t) v = p; return v; };
const avgEth = avg(ethWeek), avgBmnr = avg(bmnrWeek);

const prev = holdings;
const yieldW = num('staking-yield', prev.assumptions.weekly_staking_yield);
const ethAdded = num('eth') - prev.eth;
const stakingEst = weeklyStakingEth(prev.eth_staked, yieldW);           // staked at START of week
const purchasedEst = Math.max(0, ethAdded - stakingEst);
const purchasePrice = num('purchase-price', avgEth);
const purchaseCost = purchasedEst * purchasePrice;
const bbShares = num('buyback-shares', 0);
const bbPrice = bbShares ? num('buyback-price', avgBmnr) : null;
const bbCost = bbShares ? bbShares * bbPrice : 0;
const cashChange = num('cash') - prev.cash_usd;
// Sheet logic (L10 = ETH cost − cash decrease + buyback cost): what had to be raised from equity.
const impliedRaise = purchaseCost + bbCost + cashChange;
const issuePrice = avgBmnr;
const sharesIssued = args['shares-issued'] !== undefined ? num('shares-issued')
  : impliedRaise > 0 ? Math.round(impliedRaise / issuePrice) : 0;
const sharesOut = args['shares-outstanding'] !== undefined ? num('shares-outstanding')
  : prev.shares_outstanding + sharesIssued - bbShares;

const next = structuredClone(prev);
Object.assign(next, {
  as_of: args.asof, announced: args.date,
  eth: num('eth'), eth_staked: num('staked'), btc: num('btc'), cash_usd: num('cash'),
  beast_usd: num('beast', prev.beast_usd),
  shares_outstanding: sharesOut,
  source: { type: 'official', press_release: args.source, x_post: args.x || null, sec_8k: args.sec || null },
});
if (args['staking-yield'] !== undefined) {
  next.assumptions.weekly_staking_yield = yieldW;
  next.assumptions.weekly_staking_yield_source = `Bitmine's stated "7-day BMNR yield" in the ${args.date} release.`;
}
if (args['orbs-value']) next.orbs.reported_value_usd = num('orbs-value');
next.shares_basis = args['shares-outstanding'] !== undefined
  ? `Official count supplied on ${args.date}.`
  : `Running estimate: previous ${prev.shares_outstanding.toLocaleString('en-US')} + est. issued ${sharesIssued.toLocaleString('en-US')} − buyback ${bbShares.toLocaleString('en-US')} (week of ${args.asof}).`;
next.reference_prices = {
  ETH: num('pr-eth-price', lastOnOrBefore(eth, winEnd)),
  BTC: lastOnOrBefore(btc, winEnd),
  BMNR: lastOnOrBefore(bmnr, winEnd),
  ORBS: args['orbs-value'] ? num('orbs-value') / next.orbs.shares : lastOnOrBefore(orbs, winEnd),
  note: `Snapshot prices for ${args.asof}: ETH per press release (Coinbase) if given, BTC CoinGecko daily, BMNR last close on/before as-of date, ORBS = reported stake value ÷ assumed share count.`,
};
const nav = computeNav(next, next.reference_prices);
const r = (x, d = 0) => (x == null ? null : +x.toFixed(d));
const snap = {
  date: args.date, as_of: args.asof,
  eth: next.eth, eth_added: ethAdded, eth_staked: next.eth_staked,
  staking_yield_used: yieldW, est_staking_eth: r(stakingEst), est_purchased_eth: r(purchasedEst),
  assumed_purchase_price: r(purchasePrice, 2), purchase_price_basis: args['purchase-price'] ? 'disclosed' : 'assumed: avg daily ETH price over the week',
  est_purchase_cost: r(purchaseCost),
  buyback_shares: bbShares, buyback_price: r(bbPrice, 2),
  buyback_price_basis: bbShares ? (args['buyback-price'] ? 'disclosed' : 'assumed: avg BMNR close over the week') : null,
  cash_prev: prev.cash_usd, cash: next.cash_usd, implied_equity_raise: r(impliedRaise),
  est_shares_issued: sharesIssued, assumed_issue_price: r(issuePrice, 2),
  shares_outstanding: sharesOut, btc: next.btc,
  orbs_value: r(nav.orbsVal), beast_value: next.beast_usd,
  snapshot_prices: { ETH: r(next.reference_prices.ETH, 2), BTC: r(next.reference_prices.BTC, 0), BMNR: r(next.reference_prices.BMNR, 2) },
  full_nav: r(nav.rows[0].value), nav_per_share: r(nav.rows[0].perShare, 2), mnav: r(nav.rows[0].mnav, 3),
  eth_nav_mnav: r(nav.rows[2].mnav, 3), eth_per_share: r(nav.ethPerShare, 7),
  source: args.source, x_post: args.x || null, sec_8k: args.sec || null, notes: args.notes || '',
};
history.snapshots = history.snapshots.filter((s) => s.date !== args.date).concat(snap).sort((a, b) => a.date.localeCompare(b.date));
next.last_week = snap;
next.last_updated = new Date().toISOString();

console.log(JSON.stringify(snap, null, 2));
if (!args.dry) {
  await writeFile(H, JSON.stringify(next, null, 2) + '\n');
  await writeFile(HIST, JSON.stringify(history, null, 2) + '\n');
  console.log('wrote data/holdings.json and data/history.json');
}

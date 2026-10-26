#!/usr/bin/env node
// Rebuilds data/history.json and data/holdings.json from data/releases.json (official weekly inputs)
// using the share-estimation method documented in README.md ("Share-count reconstruction").
// Market data for each week (avg ETH, BMNR closes, BTC) is fetched once and frozen in data/weekly-prices.json.
//
// Usage: node scripts/build-history.mjs [--refetch] [--dry]
import { readFile, writeFile } from 'node:fs/promises';
import { computeNav, weeklyStakingEth } from '../assets/calc.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';
const P = (f) => new URL(`../data/${f}`, import.meta.url);
const load = async (f, d) => JSON.parse(await readFile(P(f), 'utf8').catch(() => (d === undefined ? (() => { throw new Error(f); })() : JSON.stringify(d))));
const DAY = 86400000;
const ts = (d) => Date.parse(d + 'T00:00:00Z');
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const r = (x, d = 0) => (x == null || !isFinite(x) ? null : +x.toFixed(d));

const R = await load('releases.json');
const H = await load('holdings.json');
const cache = await load('weekly-prices.json', {});
const A = H.assumptions.share_estimation;
const rel = R.releases.slice().sort((a, b) => a.as_of.localeCompare(b.as_of));

// ---------- market data ----------
async function getJSON(url) {
  for (let i = 0; i < 3; i++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (res.ok) return res.json();
    await new Promise((s) => setTimeout(s, 3000 * (i + 1)));
  }
  throw new Error('fetch failed ' + url);
}
let series = null;
async function fetchSeries() {
  if (series) return series;
  const days = Math.ceil((Date.now() - ts(rel[0].as_of)) / DAY) + 14;
  const cg = async (id) => (await getJSON(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=${Math.min(days, 365)}&interval=daily`)).prices;
  const y = (await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/BMNR?interval=1d&range=1y`)).chart.result[0];
  series = {
    eth: await cg('ethereum'), btc: await cg('bitcoin'),
    bmnr: y.timestamp.map((t, i) => [iso(t * 1000), y.indicators.quote[0].close[i]]).filter((p) => p[1] != null),
  };
  return series;
}
async function weekPrices(prevAsof, asof) {
  const key = asof;
  if (cache[key] && !process.argv.includes('--refetch')) return cache[key];
  const s = await fetchSeries();
  const lo = prevAsof ? ts(prevAsof) + DAY : ts(asof) - 6 * DAY; // first calendar day of the window
  const hi = ts(asof);
  // CoinGecko daily point stamped D 00:00 UTC ≈ close of D-1 → closes for days lo..hi are points (lo, hi+1d].
  const ethW = s.eth.filter(([t]) => t > lo && t <= hi + DAY).map((p) => p[1]);
  const btcAt = s.btc.filter(([t]) => t <= hi + DAY).at(-1);
  const bm = s.bmnr.filter(([d]) => ts(d) >= lo && ts(d) <= hi);
  const bmBefore = s.bmnr.filter(([d]) => ts(d) <= hi).at(-1);
  if (!ethW.length || !bm.length) throw new Error(`no price data for week ending ${asof}`);
  const closes = bm.map((p) => p[1]);
  cache[key] = {
    window: [iso(lo), asof], eth_avg: r(avg(ethW), 2), eth_days: ethW.length, btc_close: r(btcAt[1], 0),
    bmnr_avg: r(avg(closes), 4), bmnr_min: r(Math.min(...closes), 4), bmnr_max: r(Math.max(...closes), 4),
    bmnr_trading_days: bm.map((p) => p[0]), bmnr_close: r(bmBefore[1], 4), bmnr_close_date: bmBefore[0],
    source: 'CoinGecko daily (ETH avg, BTC), Yahoo Finance daily closes (BMNR)',
  };
  return cache[key];
}

// ---------- reconstruction ----------
const weeklyOpex = A.weekly_cash_opex_usd + A.bmnp_weekly_dividend_usd;
const anchor = R.anchor;
const out = [];
const wk = [];
for (let i = 0; i < rel.length; i++) {
  const cur = rel[i], prev = rel[i - 1];
  const px = await weekPrices(prev?.as_of, cur.as_of);
  wk.push({ cur, prev, px });
}

// Calibrate undisclosed buyback prices to the disclosed aggregate (shares × weekly avg close × k).
const agg = R.buyback_aggregate;
let disclosedCost = 0, provisional = 0;
for (const { cur, px } of wk) {
  if (!cur.buyback_shares || cur.as_of > agg.as_of) continue;
  if (cur.buyback_price) disclosedCost += cur.buyback_shares * cur.buyback_price;
  else provisional += cur.buyback_shares * px.bmnr_avg;
}
const kBuyback = provisional ? (agg.amount - disclosedCost) / provisional : 1;

// Pass 1: weekly flows
for (const w of wk) {
  const { cur, prev, px } = w;
  if (!prev) { w.flows = null; continue; }
  const days = (ts(cur.as_of) - ts(prev.as_of)) / DAY;
  const ethChange = cur.eth - prev.eth;
  const rewards = weeklyStakingEth(prev.eth_staked, cur.staking_yield_7d, days);
  const purchased = Math.max(0, ethChange - rewards);
  const ethCost = purchased * px.eth_avg;
  const bbPrice = cur.buyback_shares ? (cur.buyback_price ?? px.bmnr_avg * kBuyback) : null;
  const bbCost = cur.buyback_shares ? cur.buyback_shares * bbPrice : 0;
  const cashChange = cur.cash_usd - prev.cash_usd;
  const opex = weeklyOpex * days / 7;
  const inflows = cur.disclosed_proceeds_usd || 0;
  const raise = (o) => cashChange + ethCost + bbCost + opex * o - inflows;
  const est = (o, price) => (cur.disclosed_shares_issued != null ? cur.disclosed_shares_issued : Math.max(0, raise(o)) / price);
  // Pro-rate the week that contains the July 9 anchor: only issuance after the anchor date is added.
  const tdays = px.bmnr_trading_days;
  const after = tdays.filter((d) => d > anchor.date).length;
  const frac = ts(prev.as_of) < ts(anchor.date) && ts(cur.as_of) >= ts(anchor.date) ? after / tdays.length : 1;
  w.flows = {
    days, ethChange, rewards, purchased, ethCost, bbPrice, bbCost, cashChange, opex, inflows,
    raise: raise(1), frac,
    issued: est(1, px.bmnr_avg), issuedLow: est(0, px.bmnr_max), issuedHigh: est(A.opex_high_multiplier, px.bmnr_min),
    bbPriceBasis: cur.buyback_shares ? (cur.buyback_price ? 'disclosed' : `assumed: week avg close × ${kBuyback.toFixed(4)} (calibrated to disclosed $${(agg.amount / 1e6).toFixed(1)}M aggregate)`) : null,
  };
}
// Pass 2: shares (anchor July 9 count), forward and backward
const ai = wk.findIndex((w) => w.flows && w.flows.frac < 1) ; // week containing the anchor
let sh = anchor.shares, lo = anchor.shares, hi = anchor.shares;
const f0 = wk[ai].flows;
// shares at the start of the anchor week = anchor − pre-anchor part of that week's issuance
const pre = (x) => x * (1 - f0.frac);
wk[ai - 1].shares = [anchor.shares - pre(f0.issued), anchor.shares - pre(f0.issuedHigh), anchor.shares - pre(f0.issuedLow)];
for (let i = ai; i < wk.length; i++) {
  const f = wk[i].flows, c = wk[i].cur;
  const fr = i === ai ? f.frac : 1;
  const other = c.other_shares_issued || 0, bb = c.buyback_shares || 0;
  if (c.shares_outstanding_official) { sh = lo = hi = c.shares_outstanding_official; }
  else {
    sh += f.issued * fr + other - bb;
    lo += f.issuedLow * fr + other - bb;
    hi += f.issuedHigh * fr + other - bb;
  }
  wk[i].shares = [sh, lo, hi];
}
// weeks before the anchor week (only the opening point here)
for (let i = ai - 2; i >= 0; i--) {
  const f = wk[i + 1].flows, c = wk[i + 1].cur, [s, l, h] = wk[i + 1].shares;
  const other = c.other_shares_issued || 0, bb = c.buyback_shares || 0;
  wk[i].shares = [s - f.issued - other + bb, l - f.issuedLow - other + bb, h - f.issuedHigh - other + bb];
}

// Pass 3: NAV per week
for (const { cur, px, flows: f, shares } of wk) {
  const h = { eth: cur.eth, btc: cur.btc, cash_usd: cur.cash_usd, orbs: { shares: 1 }, beast_usd: cur.beast_usd, shares_outstanding: Math.round(shares[0]) };
  const nav = computeNav(h, { ETH: cur.eth_price_reported, BTC: px.btc_close, BMNR: px.bmnr_close, ORBS: cur.orbs_value_usd });
  const row = Object.fromEntries(nav.rows.map((x) => [x.key, x]));
  out.push({
    date: cur.date, as_of: cur.as_of, days: f?.days ?? null,
    eth: cur.eth, eth_change: f ? f.ethChange : null, eth_acquired_reported: cur.eth_acquired_reported,
    eth_staked: cur.eth_staked, staking_yield_7d: cur.staking_yield_7d,
    est_staking_eth: f ? r(f.rewards) : null, est_purchased_eth: f ? r(f.purchased) : null,
    assumed_purchase_price: f ? px.eth_avg : null, est_purchase_cost: f ? r(f.ethCost) : null,
    buyback_shares: cur.buyback_shares || 0, buyback_price: f?.bbPrice ? r(f.bbPrice, 4) : null, buyback_price_basis: f?.bbPriceBasis ?? null,
    buyback_cost: f ? r(f.bbCost) : null,
    cash_prev: f ? cur.cash_usd - f.cashChange : null, cash: cur.cash_usd, cash_change: f ? f.cashChange : null,
    est_cash_opex: f ? r(f.opex) : null, disclosed_proceeds: cur.disclosed_proceeds_usd,
    implied_equity_raise: f ? r(f.raise) : null,
    assumed_issue_price: f ? px.bmnr_avg : null, bmnr_week_range: f ? [px.bmnr_min, px.bmnr_max] : null,
    est_shares_issued: f ? r(f.issued * (f.frac ?? 1)) : null,
    est_shares_issued_range: f ? [r(f.issuedLow * f.frac), r(f.issuedHigh * f.frac)] : null,
    other_shares_issued: cur.other_shares_issued || 0,
    shares_outstanding: r(shares[0]), shares_outstanding_range: [r(shares[1]), r(shares[2])],
    btc: cur.btc, orbs_value: cur.orbs_value_usd, beast_value: cur.beast_usd,
    snapshot_prices: { ETH: cur.eth_price_reported, BTC: px.btc_close, BMNR: px.bmnr_close, BMNR_date: px.bmnr_close_date },
    nav: { full: r(row.full.value), crypto: r(row.crypto.value), eth: r(row.eth.value), ev: r(row.ev.value) },
    nav_per_share: r(row.full.perShare, 2),
    nav_per_share_all: { full: r(row.full.perShare, 2), crypto: r(row.crypto.perShare, 2), eth: r(row.eth.perShare, 2), ev: r(row.ev.perShare, 2) },
    mnav: r(row.full.mnav, 3),
    mnav_all: { full: r(row.full.mnav, 3), crypto: r(row.crypto.mnav, 3), eth: r(row.eth.mnav, 3), ev: r(row.ev.mnav, 3) },
    eth_per_share: r(nav.ethPerShare, 7),
    sec_8k: cur.sec_8k, x_post: cur.x_post, notes: cur.notes,
  });
}

// ---------- holdings.json (latest) ----------
const last = out.at(-1), lr = rel.at(-1), lp = wk.at(-1).px;
Object.assign(H, {
  as_of: lr.as_of, announced: lr.date,
  eth: lr.eth, eth_staked: lr.eth_staked, btc: lr.btc, cash_usd: lr.cash_usd, beast_usd: lr.beast_usd,
  shares_outstanding: last.shares_outstanding, shares_outstanding_range: last.shares_outstanding_range,
  source: { type: 'official', sec_8k: lr.sec_8k, x_post: lr.x_post, press_release: lr.press_release || lr.sec_8k },
  reference_prices: { ETH: lr.eth_price_reported, BTC: lp.btc_close, BMNR: lp.bmnr_close, ORBS: lr.orbs_value_usd / H.orbs.shares,
    note: `As-of ${lr.as_of}: ETH per release, BTC CoinGecko, BMNR close ${lp.bmnr_close_date}, ORBS = reported stake ÷ shares held.` },
  last_week: last, last_updated: new Date().toISOString(),
});
H.orbs.reported_value_usd = lr.orbs_value_usd;
H.assumptions.weekly_staking_yield = lr.staking_yield_7d;
H.assumptions.weekly_staking_yield_source = `Bitmine's stated 7-day BMNR yield in the ${lr.date} release.`;
H.share_estimation_meta = { buyback_price_calibration_k: r(kBuyback, 4), weekly_cash_outflow_used: r(weeklyOpex), built: new Date().toISOString() };

const hist = {
  description: 'Week-by-week reconstruction from official Bitmine releases since the last official share count (603,226,394 on 2026-07-09). est_* / assumed_* fields are estimates; see README "Share-count reconstruction".',
  method: { anchor, buyback_aggregate: agg, buyback_price_calibration_k: r(kBuyback, 4), ...A },
  snapshots: out,
};
for (const s of out) console.log(s.date, String(s.eth).padStart(9), (s.est_shares_issued ?? '').toString().padStart(11), String(s.buyback_shares).padStart(8), String(s.shares_outstanding).padStart(11), s.shares_outstanding_range.join('–'), s.nav_per_share, s.mnav);
console.log('k_buyback', kBuyback.toFixed(4));
if (!process.argv.includes('--dry')) {
  await writeFile(P('history.json'), JSON.stringify(hist, null, 2) + '\n');
  await writeFile(P('holdings.json'), JSON.stringify(H, null, 2) + '\n');
  await writeFile(P('weekly-prices.json'), JSON.stringify(cache, null, 2) + '\n');
  console.log('wrote history.json, holdings.json, weekly-prices.json');
}

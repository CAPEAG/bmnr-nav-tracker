#!/usr/bin/env node
// Rebuilds data/history.json, data/backtest.json and data/holdings.json from
//   data/releases.json    – official weekly inputs (8-K Ex. 99 / @BitMNR) since Nov 30, 2025
//   data/checkpoints.json – official share counts + ATM disclosures from 10-Qs
// using the share-estimation method in scripts/model.mjs (documented in README "Share-count reconstruction").
// Market data per week (avg ETH, BMNR closes, BTC) is fetched once and frozen in data/weekly-prices.json.
//
// Usage: node scripts/build-history.mjs [--refetch] [--dry]
import { readFile, writeFile } from 'node:fs/promises';
import { computeNav } from '../assets/calc.js';
import { weekFlows, rollForward, weekIndexOf, fracOnOrBefore, ts } from './model.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';
const P = (f) => new URL(`../data/${f}`, import.meta.url);
// BUILD_OUT=<dir>: write the generated files there instead of data/ (used by the tests)
const OUTP = (f) => (process.env.BUILD_OUT ? new URL(`file://${process.env.BUILD_OUT.replace(/\/$/, '')}/${f}`) : P(f));
const load = async (f, d) => JSON.parse(await readFile(P(f), 'utf8').catch(() => (d === undefined ? (() => { throw new Error(f); })() : JSON.stringify(d))));
const DAY = 86400000;
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const r = (x, d = 0) => (x == null || !isFinite(x) ? null : +x.toFixed(d));

const R = await load('releases.json');
const C = await load('checkpoints.json');
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
  const start = ts(rel[0].as_of) - 14 * DAY;
  const days = Math.min(365, Math.ceil((Date.now() - start) / DAY));
  const cg = async (id) => (await getJSON(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=${days}&interval=daily`)).prices;
  const y = (await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/BMNR?interval=1d&period1=${Math.floor(start / 1000)}&period2=${Math.floor(Date.now() / 1000)}`)).chart.result[0];
  series = {
    eth: await cg('ethereum'), btc: await cg('bitcoin'),
    bmnr: y.timestamp.map((t, i) => [iso(t * 1000), y.indicators.quote[0].close[i]]).filter((p) => p[1] != null),
  };
  return series;
}
async function weekPrices(prevAsof, asof) {
  if (cache[asof] && !process.argv.includes('--refetch')) return cache[asof];
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
  cache[asof] = {
    window: [iso(lo), asof], eth_avg: r(avg(ethW), 2), eth_days: ethW.length, btc_close: r(btcAt[1], 0),
    bmnr_avg: r(avg(closes), 4), bmnr_min: r(Math.min(...closes), 4), bmnr_max: r(Math.max(...closes), 4),
    bmnr_trading_days: bm.map((p) => p[0]), bmnr_close: r(bmBefore[1], 4), bmnr_close_date: bmBefore[0],
    source: 'CoinGecko daily (ETH avg, BTC), Yahoo Finance daily closes (BMNR)',
  };
  return cache[asof];
}

const wk = [];
for (let i = 0; i < rel.length; i++) wk.push({ cur: rel[i], prev: rel[i - 1], px: await weekPrices(rel[i - 1]?.as_of, rel[i].as_of) });

// Calibrate undisclosed buyback prices to the disclosed aggregate (shares × weekly avg close × k).
const agg = R.buyback_aggregate;
let disclosedCost = 0, provisional = 0;
for (const { cur, px } of wk) {
  if (!cur.buyback_shares || cur.as_of > agg.as_of) continue;
  if (cur.buyback_price) disclosedCost += cur.buyback_shares * cur.buyback_price;
  else provisional += cur.buyback_shares * px.bmnr_avg;
}
const kBuyback = provisional ? (agg.amount - disclosedCost) / provisional : 1;

// ---------- ETH purchase price per week ----------
// What Bitmine paid per ETH, from the 10-Q digital-asset roll-forward (checkpoints.json → eth_cost_quarterly):
// cost of ETH purchased ÷ units purchased, compared with the purchase-weighted weekly average ETH price.
// Weeks inside a filed quarter use that quarter's factor ('disclosed'); later weeks use the factor pooled over all
// filed quarters ('assumed', ± the largest quarterly deviation as the range). On-chain tracker prices are recorded per
// week as a cross-check; they are used ('on-chain') only if assumptions.share_estimation.use_onchain_price is true.
const OC = (await load('onchain-purchases.json', { events: [] })).events;
// Wallet-based weekly check (scripts/onchain-check.mjs → onchain-check.json): cross-check only, never the price used.
const OCW = (await load('onchain-check.json', { weeks: {} })).weeks;
const ocwFor = (date, used) => { const w = OCW[date]; if (!w) return undefined;
  return { status: w.status, onchain_vwap: w.onchain_vwap, onchain_eth: w.onchain_eth, assumed: used,
    diff_pct: w.onchain_vwap && used ? r((w.onchain_vwap / used - 1) * 100, 2) : null, coverage: w.coverage, transfers: w.transfers.filter((t) => t.counted).length }; };
const QS = (C.eth_cost_quarterly?.quarters || []).map((q) => {
  const ws = wk.filter((w) => w.prev && w.cur.as_of > q.from && w.cur.as_of <= q.to);
  const add = ws.reduce((t, w) => t + (w.cur.eth - w.prev.eth), 0);
  const mkt = q.market_avg_weighted ?? (ws.length ? ws.reduce((t, w) => t + (w.cur.eth - w.prev.eth) * w.px.eth_avg, 0) / add : null);
  const paid = q.purchase_cost_usd / q.eth_units_purchased;
  return { ...q, paid_per_eth: r(paid, 2), market_avg_weighted: r(mkt, 2), factor: r(paid / mkt, 4), weeks: ws.length };
});
const pooled = (qs) => qs.reduce((t, q) => t + q.purchase_cost_usd, 0) / qs.reduce((t, q) => t + q.eth_units_purchased * q.market_avg_weighted, 0);
const ETH_F = pooled(QS);
const ETH_UNC = A.eth_price_uncertainty ?? Math.ceil(Math.max(...QS.map((q) => Math.abs(q.factor / ETH_F - 1))) * 200) / 200;
const ocFor = (i) => {
  const { cur, prev } = wk[i];
  if (!prev) return null;
  const ev = OC.filter((e) => e.time_utc.slice(0, 10) > prev.as_of && e.time_utc.slice(0, 10) <= cur.as_of);
  if (!ev.length) return null;
  const eth = ev.reduce((t, e) => t + e.eth, 0), usdv = ev.reduce((t, e) => t + e.usd, 0);
  return { events: ev.length, eth, implied_price: r(usdv / eth, 2), sources: ev.map((e) => e.source) };
};
const quarterOf = (asof) => QS.find((q) => asof > q.from && asof <= q.to);
// Price function for a given information set (qs = quarters known; perQuarter = use each week's own quarter if filed)
function ethPriceFn(qs, perQuarter) {
  const f = pooled(qs);
  return (i) => {
    const { cur, px } = wk[i];
    if (cur.eth_purchase_cost_usd != null) // a release that states the dollars spent on ETH that week
      return { total: cur.eth_purchase_cost_usd, price: null, basis: 'disclosed', unc: 0, source: `release: $${n0(cur.eth_purchase_cost_usd)} spent on ETH (${cur.sec_8k})` };
    const q = perQuarter && quarterOf(cur.as_of);
    if (q && qs.includes(q)) return { price: px.eth_avg * q.factor, basis: 'disclosed', unc: 0, factor: q.factor, source: `${q.source}: paid $${n0(q.paid_per_eth)}/ETH vs $${n0(q.market_avg_weighted)} market (×${q.factor})` };
    const oc = A.use_onchain_price && ocFor(i);
    if (oc) return { price: oc.implied_price, basis: 'on-chain', unc: ETH_UNC, source: oc.sources.join(' ') };
    return { price: px.eth_avg * f, basis: 'assumed', unc: ETH_UNC, factor: r(f, 4), source: `weekly avg × ${f.toFixed(4)} (pooled 10-Q factor, ${qs.length} quarters)` };
  };
}
const n0 = (x) => Math.round(x).toLocaleString('en-US');
// Other digital-asset cash from the 10-Qs (cash paid ≠ cost of ETH added that week), known from each filing date.
const TI = C.eth_cost_quarterly?.cash_timing_items?.items || [];
const tiWeeks = TI.map((t) => {
  const idx = wk.map((w, i) => i).filter((i) => wk[i].prev && wk[i].cur.as_of > t.from && wk[i].cur.as_of <= t.to);
  const wts = idx.map((i) => Math.max(0, wk[i].cur.eth - wk[i].prev.eth) * wk[i].px.eth_avg);
  const tot = wts.reduce((a, b) => a + b, 0);
  return { ...t, alloc: new Map(idx.map((i, j) => [i, (t.usd * wts[j]) / tot])) };
});
const extraCashFn = (knownBy) => (i) => {
  const xs = tiWeeks.filter((t) => (!knownBy || t.known_from <= knownBy) && t.alloc.has(i));
  if (!xs.length) return null;
  return { usd: xs.reduce((a, t) => a + t.alloc.get(i), 0), what: xs.map((t) => t.what).join(' ') };
};

// ---------- models ----------
// v1 = the method used for the Jul 9 – Oct 26, 2026 reconstruction (before the first backtest).
// v2 = first recalibration (ETH at weekly avg × 1.05 fitted on 10-Q cash flows; unlimited surplus carry-forward).
// v3 = current: ETH price from the 10-Q cost per ETH (per quarter / pooled), surplus carry-forward capped.
const base = { opex_weekly: A.weekly_cash_opex_usd, bmnp_weekly: A.bmnp_weekly_dividend_usd, bmnp_start: A.bmnp_start,
  include_investments: A.include_investments, staking_lag_reports: A.staking_lag_reports, staking_realization: A.staking_realization,
  opex_high_multiplier: A.opex_high_multiplier };
const MODELS = {
  v1: { label: 'v1 – original (Jul–Oct 2026)', opex_weekly: 3257538, bmnp_weekly: A.bmnp_weekly_dividend_usd, bmnp_start: A.bmnp_start,
    include_investments: false, staking_lag_reports: 0, staking_realization: 1, carry_forward: false, opex_high_multiplier: 2 },
  v2: { label: 'v2 – ETH × 1.05, unlimited carry', ...base, carry_forward: true, eth_cost_factor: 1.05 },
  v3: { label: 'v3 – 10-Q ETH price, capped carry (current)', ...base, carry_forward: A.carry_forward, carry_weeks: A.carry_weeks, carry_max_usd: A.carry_max_usd,
    ethPrice: ethPriceFn(QS, true), extraCash: extraCashFn(null), eth_price: 'per week: disclosed (10-Q quarter) / assumed (pooled 10-Q factor)' },
};
// Walk-forward v3: each interval only knows the 10-Q ETH cost data filed by its start (quarters ended on/before it),
// and prices every week at that pooled factor ('assumed').
MODELS.v3_walkforward = { ...MODELS.v3, label: 'v3 walk-forward (ETH factor from earlier 10-Qs only)', walkforward: true, ethPrice: undefined };
// Sensitivity variants (backtest diagnostics only)
const VARIANTS = {
  'v3, no carry-forward': { ...MODELS.v3, carry_forward: false },
  'v3, unlimited carry': { ...MODELS.v3, carry_weeks: Infinity, carry_max_usd: Infinity },
  'v3, carry 2 wk / $5M': { ...MODELS.v3, carry_weeks: 2, carry_max_usd: 5e6 },
  'v3, carry 3 wk / $5M': { ...MODELS.v3 },
  'v3, carry 4 wk / $10M': { ...MODELS.v3, carry_weeks: 4, carry_max_usd: 10e6 },
  'v3, carry 8 wk / $25M': { ...MODELS.v3, carry_weeks: 8, carry_max_usd: 25e6 },
  'v3 without 10-Q digital-asset timing items': { ...MODELS.v3, extraCash: undefined },
  'v3 but ETH = weekly avg × 1.00, no timing items': { ...MODELS.v3, ethPrice: undefined, extraCash: undefined, eth_cost_factor: 1 },
  'v3 but ETH = weekly avg × 1.05, no timing items': { ...MODELS.v3, ethPrice: undefined, extraCash: undefined, eth_cost_factor: 1.05 },
  'v3 but on-chain prices where tracked': { ...MODELS.v3, ethPrice: (i) => { const oc = ocFor(i); return oc ? { price: oc.implied_price, basis: 'on-chain', unc: 0 } : MODELS.v3.ethPrice(i); } },
};
const flowsFor = (m) => wk.map((_, i) => weekFlows(wk, i, m, kBuyback));
const flowsBy = Object.fromEntries(Object.entries(MODELS).filter(([, m]) => !m.walkforward).map(([k, m]) => [k, flowsFor(m)]));
// known at an anchor date = quarters ended on/before it (their 10-Q also publishes the anchor) and timing items filed by then
const filedBy = (date) => { const qs = QS.filter((q) => q.to <= date); return qs.length ? qs.at(-1).filed : QS[0].filed; };
const wfModel = (m, date) => { const qs = QS.filter((q) => q.to <= date); return { ...m, ethPrice: ethPriceFn(qs.length ? qs : QS.slice(0, 1), false), extraCash: extraCashFn(filedBy(date)) }; };

// Held-out test (checkpoints.json → out_of_sample): the first interval after the v3 freeze, reported apart from the in-sample rows.
const OOS = C.out_of_sample || null;
// ---------- backtest (out-of-sample: start at an official count, never use the next filing) ----------
const cps = C.checkpoints;
const atmFor = (a, b) => C.atm_disclosures.filter((x) => x.from > a && x.to <= b);
const intervals = [];
for (let j = 0; j + 1 < cps.length; j++) intervals.push([cps[j], cps[j + 1], 'consecutive']);
const cpAt = (d) => cps.find((c) => c.date === d);
intervals.push([cpAt('2026-02-28'), cpAt('2026-05-31'), 'quarter (skips the Apr 13 cover count)']);
intervals.push([cpAt('2025-11-30'), cpAt('2026-07-09'), 'long horizon, no re-anchoring']);
const backtest = intervals.map(([s, e, kind]) => {
  const atm = atmFor(s.date, e.date);
  const offShares = atm.length && atm.every((x) => x.shares != null) ? atm.reduce((t, x) => t + x.shares, 0) : null;
  const offNet = atm.length && atm.every((x) => x.net_usd != null) ? atm.reduce((t, x) => t + x.net_usd, 0) : null;
  const res = {};
  for (const [k, m0] of Object.entries({ ...MODELS, ...VARIANTS })) {
    const m = m0.walkforward ? wfModel(m0, s.date) : m0;
    const o = rollForward(wk, flowsBy[k] || flowsFor(m), m, s.date, s.shares, e.date);
    res[k] = {
      est_shares: r(o.shares[1]), est_range: [r(o.shares[0]), r(o.shares[2])],
      error_shares: r(o.shares[1] - e.shares), error_pct: r(((o.shares[1] - e.shares) / e.shares) * 100, 2),
      est_issued: r(o.issued[1]), est_other: o.other, est_buybacks: o.bb,
      issued_error: offShares != null ? r(o.issued[1] - offShares) : null,
      issued_error_pct: offShares ? r(((o.issued[1] - offShares) / offShares) * 100, 1) : null,
      est_proceeds_usd: r(o.proceeds[1]), proceeds_error_usd: offNet != null ? r(o.proceeds[1] - offNet) : null,
      proceeds_error_pct: offNet ? r(((o.proceeds[1] - offNet) / offNet) * 100, 1) : null,
      within_range: e.shares >= o.shares[0] && e.shares <= o.shares[2],
    };
  }
  return {
    from: s.date, to: e.date, kind,
    start_shares: s.shares, official_end_shares: e.shares, official_change: e.shares - s.shares,
    official_atm_shares: offShares, official_atm_net_usd: offNet,
    flagged: !!(s.note && s.date === '2026-04-13') || !!(e.note && e.date === '2026-04-13'),
    out_of_sample: !!(OOS && s.date === OOS.from && e.date === OOS.to) || undefined,
    sources: [s.url, e.url], models: res,
  };
});

// Quarter diagnostics: model components vs the 10-Q cash-flow statement.
const diag = (k, from, to) => {
  const i0 = weekIndexOf(wk, from), i1 = weekIndexOf(wk, to);
  let eth = 0, rew = 0, opex = 0, inv = 0, cash = 0, need = 0;
  for (let i = i0 + 1; i <= i1; i++) { const f = flowsBy[k][i]; eth += f.ethCost; rew += f.rewards; opex += f.opex; inv += f.investments; cash += f.cashChange; need += f.need[1]; }
  return { weeks: [wk[i0].cur.as_of, wk[i1].cur.as_of], eth_purchase_cost: r(eth), staking_eth: r(rew), opex: r(opex), investments: r(inv), cash_change: r(cash), cash_need: r(need) };
};
const diagnostics = Object.fromEntries(Object.keys(flowsBy).map((k) => [k, {
  'Dec 1, 2025 – Feb 28, 2026': diag(k, '2025-11-30', '2026-03-01'),
  'Mar 1 – May 31, 2026': diag(k, '2026-03-01', '2026-05-31'),
}]));

// ---------- reconstruction (current model), anchored at each official checkpoint ----------
const M = MODELS.v3, F = flowsBy.v3;
const anchors = cps.filter((c) => c.use_as_anchor !== false);
const est = wk.map(() => null);
for (let j = 0; j < anchors.length; j++) {
  const s = anchors[j], next = anchors[j + 1];
  const o = rollForward(wk, F, M, s.date, s.shares, null);
  for (const row of o.rows) {
    if (next && wk[row.i].cur.as_of >= next.date && weekIndexOf(wk, next.date) !== row.i) break;
    const sh = [0, 1, 2].map((k) => s.shares + row.issued[k] + row.other - row.bb);
    est[row.i] = { shares: sh, anchor: s, weeks_since: row.i - o.i0, det: row.det };
  }
}
// the week containing a later anchor is re-based on that anchor (official count + issuance after it that week)
for (const a of anchors) {
  const i = weekIndexOf(wk, a.date);
  if (i < 0) continue;
  const f = F[i];
  const after = 1 - fracOnOrBefore(wk[i].px, a.date);
  const add = (k) => (f && after > 0 ? Math.max(0, f.need[k] * after) / f.price[k] : 0);
  const det = [0, 1, 2].map((k) => (f ? { need: f.need[k] * after, carried_in: 0, used: 0, funded: Math.max(0, f.need[k] * after), shares: add(k), carried_out: 0, dropped: 0, reanchored: true } : null));
  est[i] = { shares: [0, 1, 2].map((k) => a.shares + add(k)), anchor: a, weeks_since: 0, det, official: after === 0 || Math.abs(ts(wk[i].cur.as_of) - ts(a.date)) <= DAY };
}
// per-week issuance for display (difference of consecutive estimates, net of other/buybacks)
const out = [];
for (let i = 0; i < wk.length; i++) {
  const { cur, px } = wk[i], f = F[i], e = est[i];
  const prevE = est[i - 1];
  const sameSeg = prevE && e && prevE.anchor === e.anchor;
  const issued = (k) => (sameSeg ? e.shares[k] - prevE.shares[k] - (cur.other_shares_issued || 0) + (cur.buyback_shares || 0) : null);
  // BMNP preferred (liquidation preference) is a claim ahead of common from its Jun 10, 2026 issue date
  const prefOn = H.preferred && cur.as_of >= H.preferred.issued;
  const h = { eth: cur.eth, btc: cur.btc, cash_usd: cur.cash_usd, orbs: { shares: 1 }, beast_usd: cur.beast_usd, shares_outstanding: Math.round(e.shares[1]),
    preferred: prefOn ? H.preferred : null, debt_usd: H.debt_usd || 0 };
  const nav = computeNav(h, { ETH: cur.eth_price_reported, BTC: px.btc_close, BMNR: px.bmnr_close, ORBS: cur.orbs_value_usd });
  const row = Object.fromEntries(nav.rows.map((x) => [x.key, x]));
  const cpIn = cps.filter((c) => weekIndexOf(wk, c.date) === i).map((c) => ({ date: c.date, shares: c.shares, basis: c.basis, url: c.url, used_as_anchor: c.use_as_anchor !== false }));
  out.push({
    date: cur.date, as_of: cur.as_of, days: f?.days ?? null,
    eth: cur.eth, eth_change: f ? f.ethChange : null, eth_acquired_reported: cur.eth_acquired_reported,
    eth_staked: cur.eth_staked, staking_yield_7d: cur.staking_yield_7d,
    est_staking_eth: f ? r(f.rewards) : null, est_purchased_eth: f ? r(f.purchased) : null,
    eth_week_avg: f ? px.eth_avg : null,
    eth_price_used: f ? r(f.ethPrice, 2) : null, eth_price_basis: f ? f.ethBasis : null, eth_price_source: f ? f.ethSource : null,
    eth_price_factor: f?.ethFactor != null ? r(f.ethFactor, 4) : undefined,
    eth_price_range: f && f.ethUnc ? [r(f.ethPrice * (1 - f.ethUnc), 2), r(f.ethPrice * (1 + f.ethUnc), 2)] : null,
    onchain_check: ocFor(i) || undefined,
    onchain_wallet_check: ocwFor(cur.date, f ? r(f.ethPrice, 2) : null),
    other_digital_asset_cash: f?.extraCash ? r(f.extraCash) : undefined, other_digital_asset_cash_note: f?.extraCash ? f.extraWhat : undefined,
    est_purchase_cost: f ? r(f.ethCost) : null,
    buyback_shares: cur.buyback_shares || 0, buyback_price: f?.bbPrice ? r(f.bbPrice, 4) : null,
    buyback_price_basis: cur.buyback_shares ? (cur.buyback_price ? 'disclosed' : `assumed: week avg close × ${kBuyback.toFixed(4)} (calibrated to disclosed $${(agg.amount / 1e6).toFixed(1)}M aggregate)`) : null,
    buyback_cost: f ? r(f.bbCost) : null,
    cash_prev: f ? cur.cash_usd - f.cashChange : null, cash: cur.cash_usd, cash_change: f ? f.cashChange : null,
    est_cash_opex: f ? r(f.opex) : null, investments: cur.investments_usd || 0, disclosed_proceeds: cur.disclosed_proceeds_usd,
    est_spending: f ? r(f.spending) : null,
    cash_shortfall: f ? r(f.need[1]) : null, // spending − cash drop − disclosed non-common proceeds (negative = surplus)
    cash_shortfall_range: f ? [r(f.need[0]), r(f.need[2])] : null,
    surplus_from_prior: e?.det?.[1] ? r(e.det[1].used) : null,
    funded_by_shares: e?.det?.[1] ? r(e.det[1].funded) : null,
    funded_by_shares_range: e?.det?.[0] ? [r(e.det[0].funded), r(e.det[2].funded)] : null,
    surplus_carried_out: e?.det?.[1] ? r(e.det[1].carried_out) : null,
    surplus_dropped: e?.det?.[1]?.dropped ? r(e.det[1].dropped) : undefined,
    assumed_issue_price: f ? px.bmnr_avg : null, bmnr_week_range: f ? [px.bmnr_min, px.bmnr_max] : null,
    est_shares_issued: sameSeg ? r(issued(1)) : null,
    est_shares_issued_range: sameSeg ? [r(issued(0)), r(issued(2))] : null,
    other_shares_issued: cur.other_shares_issued || 0,
    shares_outstanding: r(e.shares[1]), shares_outstanding_range: [r(e.shares[0]), r(e.shares[2])],
    shares_basis: e.official ? 'official' : 'estimate',
    shares_anchor: { date: e.anchor.date, shares: e.anchor.shares, weeks_since: e.weeks_since },
    checkpoints_in_week: cpIn.length ? cpIn : undefined,
    btc: cur.btc, orbs_value: cur.orbs_value_usd, beast_value: cur.beast_usd,
    snapshot_prices: { ETH: cur.eth_price_reported, BTC: px.btc_close, BMNR: px.bmnr_close, BMNR_date: px.bmnr_close_date },
    preferred_usd: nav.pref, debt_usd: nav.debt,
    nav: { full: r(row.full.value), net: r(row.net.value), crypto: r(row.crypto.value), eth: r(row.eth.value), ev: r(row.ev.value), nav_ex_cash: r(row.ev.navExCash) },
    // headline NAV/share and mNAV are net of the BMNP preferred (from Jun 10, 2026); gross figures kept alongside
    nav_per_share: r(row.net.perShare, 2), nav_per_share_gross: r(row.full.perShare, 2),
    nav_per_share_all: { full: r(row.full.perShare, 2), net: r(row.net.perShare, 2), crypto: r(row.crypto.perShare, 2), eth: r(row.eth.perShare, 2) },
    mnav: r(row.net.mnav, 3), mnav_gross: r(row.full.mnav, 3),
    mnav_all: { full: r(row.full.mnav, 3), net: r(row.net.mnav, 3), crypto: r(row.crypto.mnav, 3), eth: r(row.eth.mnav, 3), ev_to_nav_ex_cash: r(row.ev.mnav, 3) },
    eth_per_share: r(nav.ethPerShare, 7),
    funding_flag: cur.funding_flag || undefined,
    sec_8k: cur.sec_8k, x_post: cur.x_post, notes: cur.notes,
  });
}

// ---------- weekly accretion check (per-share effect of capital actions, v2 estimates) ----------
// NAV/share before the week's actions = last week's assets with ETH revalued at this week's average ETH price.
for (let i = 1; i < out.length; i++) {
  const s = out[i], p = out[i - 1], f = F[i];
  if (!f || !s.eth_week_avg) continue;
  const S0 = p.shares_outstanding, S1 = s.shares_outstanding, ethAvg = s.eth_week_avg;
  const navBefore = (p.nav.net - p.eth * p.snapshot_prices.ETH + p.eth * ethAvg) / S0; // NAV net of preferred
  // BMNP issued: net cash proceeds − liquidation preference added (issued at $80 vs $100 → dilutive to common)
  const prefAdded = (s.preferred_usd || 0) - (p.preferred_usd || 0);
  const prefUsd = prefAdded ? (s.disclosed_proceeds || 0) - prefAdded : 0;
  const reanchor = s.est_shares_issued == null;
  const atm = reanchor ? Math.max(0, f.need[1]) / f.price[1] : s.est_shares_issued;
  const other = s.other_shares_issued || 0, bb = s.buyback_shares || 0;
  const issuePx = s.assumed_issue_price;
  const premiumUsd = f.ethCost - f.purchased * ethAvg; // cash paid above the week's average ETH price
  const usd = {
    issuance: ((atm + other) * (issuePx - navBefore)) / S1,
    buybacks: bb ? (bb * (navBefore - s.buyback_price)) / S1 : 0,
    staking: (f.rewards * s.snapshot_prices.ETH) / S1,
    other: (prefUsd - premiumUsd - f.opex) / S1,
  };
  usd.total = usd.issuance + usd.buybacks + usd.staking + usd.other;
  usd.actual_change = s.nav_per_share - p.nav_per_share;
  usd.market = usd.actual_change - usd.total;
  const eps0 = p.eth / S0, dS = S1 - S0;
  const correction = dS - (atm + other - bb); // share-count true-up at an official checkpoint
  const eth = {
    capital: f.ethCost / ethAvg / S1 - (eps0 * (atm + other - bb)) / S1,
    staking: f.rewards / S1,
    premium: -(f.ethCost / ethAvg - f.purchased) / S1,
    reanchor: reanchor ? -(eps0 * correction) / S1 : 0,
  };
  // capital = ETH bought at market with the cash used − dilution from net issuance; premium = ETH lost to paying above the average price
  eth.total = eth.capital + eth.staking + eth.premium + eth.reanchor;
  eth.actual_change = s.eth / S1 - eps0;
  const R = (o, d) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Number(v.toFixed(d))]));
  s.accretion = {
    basis: reanchor ? 'estimate (week re-anchored to an official 10-Q count; ATM issuance from the model)' : 'estimate (v3 model)',
    reanchor, nav_per_share_before: Number(navBefore.toFixed(4)), atm_shares: Math.round(atm), mnav_at_issue: Number((issuePx / navBefore).toFixed(3)),
    usd_per_share: R(usd, 4), eth_per_share: R(eth, 9),
  };
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
const latestCp = cps.filter((c) => c.use_as_anchor !== false).at(-1);
H.shares_official = { shares: latestCp.shares, date: latestCp.date, source: latestCp.source, url: latestCp.url, next_expected: H.shares_official?.next_expected };
H.orbs.reported_value_usd = lr.orbs_value_usd;
H.assumptions.weekly_staking_yield = lr.staking_yield_7d;
H.assumptions.weekly_staking_yield_source = `Bitmine's stated 7-day BMNR yield in the ${lr.date} release.`;
H.share_estimation_meta = { buyback_price_calibration_k: r(kBuyback, 4), built: new Date().toISOString() };
// Staking accrual since the last report (Holdings card): same lagged basis as model.mjs — the smallest staked balance
// over the last 1 + staking_lag_reports reports (newly staked ETH waits in the validator entry queue).
{ const lag = A.staking_lag_reports || 0, hs = rel.slice(-(lag + 1)).map((x) => x.eth_staked || 0);
  H.staking_accrual_basis = { eth: lag ? Math.min(...hs) : lr.eth_staked, realization: A.staking_realization ?? 1,
    rule: `min ETH staked over the last ${lag + 1} reports (staking_lag_reports = ${lag}), as in scripts/model.mjs` }; }

// ---------- valuation.json derived inputs (refreshed weekly) ----------
const V = JSON.parse(await readFile(P('valuation.json'), 'utf8'));
const ys = rel.filter((x) => x.staking_yield_7d).map((x) => x.staking_yield_7d);
const tavg = (n) => { const a = ys.slice(-n); return Number((a.reduce((t, x) => t + x, 0) / a.length).toFixed(5)); };
const trj = rel.filter((x, i) => x.eth_staked && (i % 4 === 0 || i === rel.length - 1)).map((x) => ({ as_of: x.as_of, staked: x.eth_staked, pct: Number((x.eth_staked / x.eth).toFixed(4)) }));
V.derived = {
  as_of: lr.as_of, source: `Bitmine weekly releases in data/releases.json (latest: ${lr.sec_8k})`,
  eth_held: lr.eth, eth_staked: lr.eth_staked,
  staked_share_current: { value: Number((lr.eth_staked / lr.eth).toFixed(4)), label: `current: ${lr.eth_staked.toLocaleString('en-US')} ÷ ${lr.eth.toLocaleString('en-US')} ETH (${lr.as_of})` },
  yield_latest_7d: { value: lr.staking_yield_7d, label: `latest stated 7-day yield (${lr.as_of})` },
  yield_trailing_4w: { value: tavg(4), label: '4-week average of stated 7-day yields' },
  yield_trailing_13w: { value: tavg(13), label: '13-week average of stated 7-day yields' },
  yield_trailing_26w: { value: tavg(26), label: '26-week average of stated 7-day yields' },
  staked_trajectory: trj,
};
console.log('valuation derived', JSON.stringify({ ...V.derived, staked_trajectory: undefined }));

const summarize = (k) => {
  const xs = backtest.filter((b) => !b.flagged && !b.out_of_sample && b.kind !== 'long horizon, no re-anchoring' && !(b.kind === 'consecutive' && b.from === '2026-02-28')).map((b) => b.models[k]);
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  return { intervals: xs.length, mean_abs_error_shares: r(mean(xs.map((x) => Math.abs(x.error_shares)))), mean_abs_error_pct: r(mean(xs.map((x) => Math.abs(x.error_pct))), 2),
    mean_error_shares: r(mean(xs.map((x) => x.error_shares))), mean_error_pct: r(mean(xs.map((x) => x.error_pct)), 2), within_range: xs.filter((x) => x.within_range).length };
};
// Current estimate (latest anchor → latest week) under each model / variant
const lastAnchor = cps.filter((c) => c.use_as_anchor !== false).at(-1);
const current = Object.fromEntries(Object.entries({ ...MODELS, ...VARIANTS }).map(([k, m0]) => {
  const m = m0.walkforward ? wfModel(m0, lastAnchor.date) : m0;
  const o = rollForward(wk, flowsBy[k] || flowsFor(m), m, lastAnchor.date, lastAnchor.shares, null);
  return [k, { shares: r(o.shares[1]), range: [r(o.shares[0]), r(o.shares[2])] }];
}));
// Held-out interval: v3 with only the information known at its start (10-Q ETH factors and timing items filed by then),
// v3 parameters as frozen in checkpoints.json. Pending until the end checkpoint (FY2026 10-K, Aug 31) is added.
const outOfSample = (() => {
  if (!OOS) return null;
  const keys = Object.keys(OOS.frozen_v3_params);
  const now = Object.fromEntries(keys.map((k) => [k, MODELS.v3[k] ?? null]));
  const params_match_freeze = keys.every((k) => JSON.stringify(now[k]) === JSON.stringify(OOS.frozen_v3_params[k]));
  const s = cpAt(OOS.from), e = cpAt(OOS.to);
  const base = { from: OOS.from, to: OOS.to, label: OOS.label, model: 'v3, information known at the interval start', frozen_on: OOS.frozen_on, params_match_freeze, params_now: now };
  if (!s || !e) return { ...base, status: 'pending 10-K' };
  const m = wfModel(MODELS.v3, s.date);
  const o = rollForward(wk, flowsFor(m), m, s.date, s.shares, e.date);
  return { ...base, status: 'recorded', official_end_shares: e.shares, est_shares: r(o.shares[1]), est_range: [r(o.shares[0]), r(o.shares[2])],
    error_shares: r(o.shares[1] - e.shares), error_pct: r(((o.shares[1] - e.shares) / e.shares) * 100, 2), within_range: e.shares >= o.shares[0] && e.shares <= o.shares[2], source: e.url };
})();
if (outOfSample && !outOfSample.params_match_freeze) console.warn('WARNING: v3 parameters differ from the out-of-sample freeze (checkpoints.json → out_of_sample)');
const bt = {
  description: 'Out-of-sample backtest: each interval starts from an official share count and rolls the weekly estimator forward using only the weekly releases, then compares with the next official count / ATM disclosure. Errors = estimate − official.',
  built: new Date().toISOString(), models: MODELS, buyback_price_calibration_k: r(kBuyback, 4),
  summary: Object.fromEntries(Object.keys(MODELS).map((k) => [k, summarize(k)])),
  variants: Object.fromEntries(Object.keys(VARIANTS).map((k) => [k, { ...summarize(k), current: current[k] }])),
  current_estimate: current, current_from: { date: lastAnchor.date, shares: lastAnchor.shares },
  eth_price: { quarters: QS, pooled_factor: r(ETH_F, 4), assumed_uncertainty: ETH_UNC, onchain_events: OC.length,
    note: 'paid_per_eth = 10-Q cost of ETH purchased ÷ units purchased; market_avg_weighted = weekly average ETH price weighted by ETH added each week; factor = paid ÷ market.' },
  out_of_sample: outOfSample,
  intervals: backtest, diagnostics, official_cash_flows: C.cash_flow_official,
};
const hist = {
  description: 'Weekly reconstruction from every official Bitmine release since Nov 30, 2025. Share counts are official at 10-Q checkpoints (checkpoints.json) and estimated between them by rolling the current model forward from the latest checkpoint. est_* / assumed_* fields are estimates; see README "Share-count reconstruction".',
  method: { model: MODELS.v3, eth_price: bt.eth_price, checkpoints: cps.map(({ date, shares, basis, url, use_as_anchor }) => ({ date, shares, basis, url, use_as_anchor })), buyback_aggregate: agg, buyback_price_calibration_k: r(kBuyback, 4), ...A },
  snapshots: out,
};
const f0 = (x) => (x == null ? '' : Math.round(x).toLocaleString('en-US'));
console.log('date        eth        issued      shares        basis     NAV/sh  mNAV');
for (const s of out) console.log(s.as_of, String(s.eth).padStart(9), f0(s.est_shares_issued).padStart(11), f0(s.shares_outstanding).padStart(12), s.shares_basis.padEnd(9), s.nav_per_share, s.mnav);
console.log('\nBACKTEST (estimate − official)');
for (const b of backtest) console.log(`${b.from} → ${b.to} ${b.flagged ? '[flag]' : '      '} official Δ ${f0(b.official_change).padStart(11)} atm ${f0(b.official_atm_shares).padStart(11)} | ` +
  Object.entries(b.models).filter(([k]) => MODELS[k]).map(([k, m]) => `${k}: est ${f0(m.est_shares)} err ${f0(m.error_shares)} (${m.error_pct}%) iss.err ${f0(m.issued_error)} $err ${f0(m.proceeds_error_usd / 1e6)}M ${m.within_range ? 'in' : 'out'}`).join(' | '));
console.log(JSON.stringify(bt.summary));
for (const [k, v] of Object.entries(bt.variants)) console.log(k.padEnd(40), `mean|err| ${v.mean_abs_error_pct}%  bias ${v.mean_error_pct}%  in-range ${v.within_range}/${v.intervals}  current ${f0(v.current.shares)} (${f0(v.current.range[0])}–${f0(v.current.range[1])})`);
console.log('current', JSON.stringify(Object.fromEntries(Object.entries(current).filter(([k]) => MODELS[k]))));
console.log('eth price', JSON.stringify(bt.eth_price));
console.log(JSON.stringify(diagnostics, null, 0));
console.log('k_buyback', kBuyback.toFixed(4));
if (!process.argv.includes('--dry')) {
  await writeFile(OUTP('history.json'), JSON.stringify(hist, null, 2) + '\n');
  await writeFile(OUTP('backtest.json'), JSON.stringify(bt, null, 2) + '\n');
  await writeFile(OUTP('holdings.json'), JSON.stringify(H, null, 2) + '\n');
  await writeFile(OUTP('weekly-prices.json'), JSON.stringify(cache, null, 2) + '\n');
  await writeFile(OUTP('valuation.json'), JSON.stringify(V, null, 2) + '\n');
  console.log('wrote history.json, backtest.json, holdings.json, weekly-prices.json');
}

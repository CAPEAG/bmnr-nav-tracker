// Share-count estimator shared by build-history.mjs (reconstruction + backtest).
// Pure functions: no I/O. See README "Share-count reconstruction".
import { weeklyStakingEth } from '../assets/calc.js';

const DAY = 86400000;
export const ts = (d) => Date.parse(d + 'T00:00:00Z');

// Weekly cash need for week i under parameter set P.
// wk[i] = { cur, prev, px } where cur/prev are releases and px the frozen weekly market data.
export function weekFlows(wk, i, P, kBuyback = 1) {
  const { cur, prev, px } = wk[i];
  if (!prev) return null;
  const days = (ts(cur.as_of) - ts(prev.as_of)) / DAY;
  const ethChange = cur.eth - prev.eth;
  // ETH that earns rewards: staked at the previous report, or (with a lag) the smallest staked
  // balance over the last 1+lag reports — newly staked ETH waits in the validator entry queue.
  const lag = P.staking_lag_reports || 0;
  const hist = wk.slice(Math.max(0, i - 1 - lag), i).map((w) => w.cur.eth_staked || 0);
  const stakedBasis = lag ? Math.min(...hist) : prev.eth_staked || 0;
  const yld = cur.staking_yield_7d ?? prev.staking_yield_7d ?? 0;
  const rewards = weeklyStakingEth(stakedBasis, yld, days) * (P.staking_realization ?? 1);
  const purchased = Math.max(0, ethChange - rewards);
  // eth_cost_factor: cash actually paid per ETH added vs the weekly-average price (calibrated to 10-Q cash flows).
  const ethCost = purchased * px.eth_avg * (P.eth_cost_factor ?? 1);
  const bbPrice = cur.buyback_shares ? cur.buyback_price ?? px.bmnr_avg * kBuyback : null;
  const bbCost = cur.buyback_shares ? cur.buyback_shares * bbPrice : 0;
  const cashChange = cur.cash_usd - prev.cash_usd;
  const bmnp = P.bmnp_start && cur.as_of > P.bmnp_start ? P.bmnp_weekly : 0;
  const opex = (P.opex_weekly + bmnp) * days / 7;
  const investments = P.include_investments ? cur.investments_usd || 0 : 0;
  const inflows = cur.disclosed_proceeds_usd || 0;
  const need = (o) => cashChange + ethCost + bbCost + investments + opex * o - inflows;
  return {
    days, ethChange, stakedBasis, yld, rewards, purchased, ethCost, bbPrice, bbCost, cashChange, opex, investments, inflows,
    need: [need(0), need(1), need(P.opex_high_multiplier ?? 2)],
    price: [px.bmnr_max, px.bmnr_avg, px.bmnr_min],
  };
}

// Fraction of week i's trading days that fall on/before date d (string YYYY-MM-DD).
export function fracOnOrBefore(px, d) {
  const t = px.bmnr_trading_days || [];
  if (!t.length) return 1;
  return t.filter((x) => x <= d).length / t.length;
}
export const weekIndexOf = (wk, d) => wk.findIndex((w) => (!w.prev || w.prev.as_of < d) && d <= w.cur.as_of);

// Roll forward from an official count at date `from`, week by week, without using anything after `to`.
// Returns per-week cumulative estimates [low, mid, high] and totals at `to`.
// Issuance = cash need ÷ BMNR price; with carry_forward a weekly cash surplus offsets later needs
// instead of being discarded (no negative issuance without a disclosed buyback).
export function rollForward(wk, flows, P, fromDate, fromShares, toDate) {
  const i0 = weekIndexOf(wk, fromDate);
  const i1 = toDate ? weekIndexOf(wk, toDate) : wk.length - 1;
  const surplus = [0, 0, 0];
  const cum = [0, 0, 0];
  const usd = [0, 0, 0];
  let needSum = 0, other = 0, bb = 0;
  const rows = [];
  for (let i = i0; i <= i1; i++) {
    const f = flows[i];
    const px = wk[i].px;
    const a = i === i0 ? 1 - fracOnOrBefore(px, fromDate) : 1;
    const b = toDate && i === i1 ? fracOnOrBefore(px, toDate) : 1;
    const w = Math.max(0, i === i0 && i === i1 ? b - (1 - a) : i === i0 ? a : b);
    const disclosed = wk[i].cur.disclosed_shares_issued;
    if (f && w > 0 && disclosed != null) {
      for (let k = 0; k < 3; k++) { cum[k] += disclosed * w; usd[k] += disclosed * w * f.price[1]; }
      if (i > i0 || a === 1) { other += wk[i].cur.other_shares_issued || 0; bb += wk[i].cur.buyback_shares || 0; }
    } else if (f && w > 0) {
      for (let k = 0; k < 3; k++) {
        let x = f.need[k] * w;
        if (P.carry_forward) { x -= surplus[k]; surplus[k] = x < 0 ? -x : 0; }
        if (x > 0) { cum[k] += x / f.price[k]; usd[k] += x; }
      }
      needSum += f.need[1] * w;
      if (i > i0 || a === 1) { other += wk[i].cur.other_shares_issued || 0; bb += wk[i].cur.buyback_shares || 0; }
    }
    rows.push({ i, w, issued: [...cum], other, bb });
  }
  const est = (k) => fromShares + cum[k] + other - bb;
  return { i0, i1, rows, issued: cum, proceeds: usd, other, bb, needSum, shares: [est(0), est(1), est(2)] };
}

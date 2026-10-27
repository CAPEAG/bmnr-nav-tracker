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
  // ETH purchase price: P.ethPrice(i) → { price, basis, unc } (per-week basis: disclosed / on-chain / assumed);
  // otherwise the weekly-average price × eth_cost_factor. unc = ± relative uncertainty used for the low/high range.
  const ep = P.ethPrice ? P.ethPrice(i) : { price: px.eth_avg * (P.eth_cost_factor ?? 1), basis: 'assumed', unc: 0 };
  const ethCost = ep.total ?? purchased * ep.price; // ep.total: dollars spent on ETH stated in the release
  if (ep.total != null) ep.price = purchased > 0 ? ep.total / purchased : px.eth_avg;
  const ethCostK = [ethCost * (1 - ep.unc), ethCost, ethCost * (1 + ep.unc)];
  const bbPrice = cur.buyback_shares ? cur.buyback_price ?? px.bmnr_avg * kBuyback : null;
  const bbCost = cur.buyback_shares ? cur.buyback_shares * bbPrice : 0;
  const cashChange = cur.cash_usd - prev.cash_usd;
  const bmnp = P.bmnp_start && cur.as_of > P.bmnp_start ? P.bmnp_weekly : 0;
  const opex = (P.opex_weekly + bmnp) * days / 7;
  const investments = P.include_investments ? cur.investments_usd || 0 : 0;
  const inflows = cur.disclosed_proceeds_usd || 0;
  // other digital-asset cash disclosed in a 10-Q (settlement timing etc.), P.extraCash(i) → { usd, what }
  const xc = P.extraCash ? P.extraCash(i, purchased) : null;
  const extra = xc?.usd || 0;
  const need = (o, k) => cashChange + ethCostK[k] + extra + bbCost + investments + opex * o - inflows;
  return {
    days, ethChange, stakedBasis, yld, rewards, purchased, ethCost, ethPrice: ep.price, ethBasis: ep.basis, ethUnc: ep.unc, ethSource: ep.source, ethFactor: ep.factor,
    bbPrice, bbCost, cashChange, opex, investments, inflows, extraCash: extra, extraWhat: xc?.what,
    // spending = everything the week's cash paid for; need = spending − cash drop (− disclosed non-common proceeds)
    spending: ethCost + extra + bbCost + investments + opex,
    need: [need(0, 0), need(1, 1), need(P.opex_high_multiplier ?? 2, 2)],
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
// Issuance = cash need ÷ BMNR price. A week whose cash need is negative (cash fell less than spending, or rose) is a
// surplus. With carry_forward the surplus offsets later weeks' needs, but only for carry_weeks weeks and up to
// carry_max_usd in total (oldest surplus used first, older/excess surplus dropped); without it each week is floored at 0.
export function rollForward(wk, flows, P, fromDate, fromShares, toDate) {
  const i0 = weekIndexOf(wk, fromDate);
  const i1 = toDate ? weekIndexOf(wk, toDate) : wk.length - 1;
  const maxW = P.carry_weeks ?? Infinity, maxUsd = P.carry_max_usd ?? Infinity;
  const pools = [[], [], []]; // per case: [{ i, amt }]
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
    const det = [null, null, null];
    if (f && w > 0 && disclosed != null) {
      for (let k = 0; k < 3; k++) { cum[k] += disclosed * w; usd[k] += disclosed * w * f.price[1]; }
      if (i > i0 || a === 1) { other += wk[i].cur.other_shares_issued || 0; bb += wk[i].cur.buyback_shares || 0; }
    } else if (f && w > 0) {
      for (let k = 0; k < 3; k++) {
        const need = f.need[k] * w;
        let pool = pools[k];
        // expire surplus older than carry_weeks
        const expired = pool.filter((s) => i - s.i > maxW).reduce((t, s) => t + s.amt, 0);
        pool = pool.filter((s) => i - s.i <= maxW);
        const avail = pool.reduce((t, s) => t + s.amt, 0);
        let used = 0, funded = 0;
        if (need > 0) {
          used = P.carry_forward ? Math.min(avail, need) : 0;
          let u = used;
          for (const s of pool) { const d = Math.min(s.amt, u); s.amt -= d; u -= d; }
          pool = pool.filter((s) => s.amt > 1e-6);
          funded = need - used;
        } else if (P.carry_forward && need < 0) {
          pool.push({ i, amt: -need });
        }
        // cap the total carried surplus (drop the oldest first)
        let tot = pool.reduce((t, s) => t + s.amt, 0), capped = 0;
        while (tot > maxUsd && pool.length) { const d = Math.min(pool[0].amt, tot - maxUsd); pool[0].amt -= d; tot -= d; capped += d; if (pool[0].amt <= 1e-6) pool.shift(); }
        pools[k] = pool;
        if (funded > 0) { cum[k] += funded / f.price[k]; usd[k] += funded; }
        det[k] = { need, carried_in: avail, used, funded, shares: funded > 0 ? funded / f.price[k] : 0, carried_out: tot, dropped: expired + capped };
      }
      needSum += f.need[1] * w;
      if (i > i0 || a === 1) { other += wk[i].cur.other_shares_issued || 0; bb += wk[i].cur.buyback_shares || 0; }
    }
    rows.push({ i, w, issued: [...cum], other, bb, det });
  }
  const est = (k) => fromShares + cum[k] + other - bb;
  return { i0, i1, rows, issued: cum, proceeds: usd, other, bb, needSum, shares: [est(0), est(1), est(2)] };
}

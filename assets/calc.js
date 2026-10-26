// Shared formulas (used by the browser page AND scripts/add-week.mjs).
// NAV, mNAV and valuation formulas (documented in README "NAV formulas").

/** NAV block. h = holdings.json, px = {ETH, BTC, BMNR, ORBS} prices in USD. */
export function computeNav(h, px) {
  const shares = h.shares_outstanding;
  const ethVal = h.eth * px.ETH;
  const btcVal = h.btc * px.BTC;
  const cash = h.cash_usd;
  const orbsVal = h.orbs.shares * px.ORBS;
  const beast = h.beast_usd;
  const mcap = shares * px.BMNR;
  const full = btcVal + ethVal + cash + orbsVal + beast;
  const cryptoCash = btcVal + ethVal + cash;
  const ethOnly = ethVal;
  const ev = mcap - cash;
  const row = (label, key, value, note) => {
    const perShare = value / shares;
    return { label, key, value, perShare, mnav: px.BMNR / perShare, note };
  };
  return {
    shares, mcap, ethVal, btcVal, cash, orbsVal, beast,
    ethPerShare: h.eth / shares,
    rows: [
      row('Full NAV', 'full', full, 'BTC + ETH + cash + ORBS stake + Beast stake'),
      row('Crypto/Cash NAV', 'crypto', cryptoCash, 'BTC + ETH + cash'),
      row('ETHUSD NAV', 'eth', ethOnly, 'ETH only'),
      row('Enterprise Value', 'ev', ev, 'Market cap − cash; "mNAV" here = market cap ÷ EV'),
    ],
  };
}

/** Staking (bear/base/bull) + MAVAN + SOTP block. */
export function computeValuation(h, px, nav) {
  const a = h.assumptions.valuation;
  const shares = h.shares_outstanding;
  const fullNavPs = nav.rows[0].perShare;
  const staked = {
    bear: h.eth_staked,                                        // latest reported staked ETH
    base: h.eth,
    bull: a.bull_eth_staked,                                   // assumption (6,105,000)
  };
  const out = {};
  for (const k of ['bear', 'base', 'bull']) {
    const y = a.staking_yield[k];
    const ethGen = y * staked[k];
    const usdGen = ethGen * px.ETH;
    const sga = k === 'bear'
      ? a.sga.bear_pct_of_rewards * usdGen + a.sga.bear_fixed
      : a.sga[k];
    const profit = usdGen - sga;
    const equity = profit * a.staking_multiple[k];
    const stakingPs = equity / shares;
    const aum = a.mavan.aum[k];
    const rewards = aum * a.mavan.reward_rate;
    const mavanProfit = rewards * a.mavan.margin[k];
    const mavanEquity = mavanProfit * a.mavan.multiple[k];
    const mavanPs = mavanEquity / shares;
    const sotp = stakingPs + fullNavPs + mavanPs;
    out[k] = {
      yield: y, staked: staked[k], ethGen, usdGen, sga, profit, multiple: a.staking_multiple[k], equity, stakingPs,
      aum, rewards, mavanProfit, mavanMultiple: a.mavan.multiple[k], mavanEquity, mavanPs,
      sotp, impliedMnav: sotp / fullNavPs,
      upside: sotp / px.BMNR - 1,
    };
  }
  return out;
}

/** Weekly staking estimate: ETH staked × annual yield × 7/365. */
export const weeklyStakingEth = (staked, annualYield, days = 7) => staked * annualYield * days / 365;

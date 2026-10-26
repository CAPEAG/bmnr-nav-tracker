// Shared formulas (used by the browser page AND scripts/add-week.mjs).
// They replicate the user's "BMNR" Google Sheet tab cell-for-cell; sheet cell refs in comments.

/** NAV block. h = holdings.json, px = {ETH, BTC, BMNR, ORBS} prices in USD. */
export function computeNav(h, px) {
  const shares = h.shares_outstanding;                       // C3
  const ethVal = h.eth * px.ETH;                               // E7 = C7*D7
  const btcVal = h.btc * px.BTC;                               // E6 = C6*D6
  const cash = h.cash_usd;                                     // E8 = C8*1
  const orbsVal = h.orbs.shares * px.ORBS;                     // E9 = C9*D9 (ORBS = Eightco Holdings stock)
  const beast = h.beast_usd;                                   // E10
  const mcap = shares * px.BMNR;                               // D3 = C3*B3
  const full = btcVal + ethVal + cash + orbsVal + beast;       // C13 = SUM(E6:E10)
  const cryptoCash = btcVal + ethVal + cash;                   // C14 = SUM(E6:E8)
  const ethOnly = ethVal;                                      // C15 = E7
  const ev = mcap - cash;                                      // C16 = D3 - C8
  const row = (label, key, value, note) => {
    const perShare = value / shares;                           // D13..D16 = C/C3
    return { label, key, value, perShare, mnav: px.BMNR / perShare, note }; // E13..E16 = B3/D
  };
  return {
    shares, mcap, ethVal, btcVal, cash, orbsVal, beast,
    ethPerShare: h.eth / shares,                               // E3 = C7/C3
    rows: [
      row('Full NAV', 'full', full, 'BTC + ETH + cash + ORBS stake + Beast stake'),
      row('Crypto/Cash NAV', 'crypto', cryptoCash, 'BTC + ETH + cash'),
      row('ETHUSD NAV', 'eth', ethOnly, 'ETH only'),
      row('Enterprise Value', 'ev', ev, 'Market cap − cash; "mNAV" here = market cap ÷ EV (as in the sheet)'),
    ],
  };
}

/** Staking (bear/base/bull) + MAVAN + SOTP block — sheet rows 19-36. */
export function computeValuation(h, px, nav) {
  const a = h.assumptions.valuation;
  const shares = h.shares_outstanding;
  const fullNavPs = nav.rows[0].perShare;                      // D13
  const staked = {
    bear: h.eth_staked,                                        // C20 (sheet: then-current staked ETH)
    base: h.eth,                                               // D20 = C7 (all ETH staked)
    bull: a.bull_eth_staked,                                   // E20 (sheet hard-code 6,105,000)
  };
  const out = {};
  for (const k of ['bear', 'base', 'bull']) {
    const y = a.staking_yield[k];                              // C19 (D19,E19 = C19)
    const ethGen = y * staked[k];                              // row 21
    const usdGen = ethGen * px.ETH;                            // row 23
    const sga = k === 'bear'
      ? a.sga.bear_pct_of_rewards * usdGen + a.sga.bear_fixed  // C24 = 0.015*C23 + 50,000,000
      : a.sga[k];                                              // D24, E24 fixed
    const profit = usdGen - sga;                               // row 25
    const equity = profit * a.staking_multiple[k];             // row 27
    const stakingPs = equity / shares;                         // row 28
    const aum = a.mavan.aum[k];                                // row 29
    const rewards = aum * a.mavan.reward_rate;                 // row 30 = AUM*0.045
    const mavanProfit = rewards * a.mavan.margin[k];           // row 31 (bear 0.1*0.985, base 0.125, bull 0.15)
    const mavanEquity = mavanProfit * a.mavan.multiple[k];     // row 33
    const mavanPs = mavanEquity / shares;                      // row 34
    const sotp = stakingPs + fullNavPs + mavanPs;              // row 35 = staking/sh + Full NAV/sh + MAVAN/sh
    out[k] = {
      yield: y, staked: staked[k], ethGen, usdGen, sga, profit, multiple: a.staking_multiple[k], equity, stakingPs,
      aum, rewards, mavanProfit, mavanMultiple: a.mavan.multiple[k], mavanEquity, mavanPs,
      sotp, impliedMnav: sotp / fullNavPs,                     // row 36 = SOTP / Full NAV per share
      upside: sotp / px.BMNR - 1,
    };
  }
  return out;
}

/** Weekly staking estimate: ETH staked × annual yield × 7/365. */
export const weeklyStakingEth = (staked, annualYield, days = 7) => staked * annualYield * days / 365;

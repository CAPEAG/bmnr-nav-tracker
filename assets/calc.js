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

/** Resolve one valuation input for a case: {value} or {ref: key in V.derived}. */
export function valInput(V, key, k) {
  const c = V.inputs[key][k];
  if (c == null) return null;
  if (typeof c === 'number') return c;
  if ('value' in c) return c.value;
  const d = V.derived?.[c.ref];
  return d && typeof d === 'object' ? d.value : d;
}

/**
 * Bear/base/bull sum-of-the-parts (inputs in data/valuation.json, documented there and in the README).
 * h = holdings.json, px = live prices, nav = computeNav(), V = valuation.json.
 */
export function computeValuation(h, px, nav, V) {
  const shares = h.shares_outstanding;
  const navPs = nav.rows[0].perShare;
  const out = {};
  for (const k of ['bear', 'base', 'bull']) {
    const g = (key) => valInput(V, key, k);
    const stakedShare = g('staked_share'), y = g('gross_yield'), leak = g('fee_leakage');
    const staked = h.eth * stakedShare;
    const ethGross = staked * y;
    const ethNet = ethGross * (1 - leak);
    const stakingUsd = ethNet * px.ETH;
    // MAVAN third-party
    const mavanMargin = g('mavan_margin');
    const existingRev = g('mavan_existing_revenue_usd');
    const newAum = g('mavan_new_aum_usd');
    const mavanRev = existingRev * (1 - g('mavan_fee_compression')) + newAum * y * g('mavan_take_rate');
    const mavanPretax = mavanRev * mavanMargin;
    // tax only on positive earnings: no benefit on losses (full valuation allowance)
    const afterTax = (x, t) => (x > 0 ? x * (1 - t) : x);
    const tax = g('tax_rate'), mavanTax = g('mavan_tax_rate') ?? tax;
    const mavanAfterTax = afterTax(mavanPretax, mavanTax);
    const mavanValue = mavanAfterTax * g('mavan_multiple');
    // corporate costs (excluding the cost of serving MAVAN clients, which sits in the MAVAN margin)
    const opex = g('opex_usd'), mavanCostInOpex = existingRev * (1 - mavanMargin);
    const corpOpex = opex - mavanCostInOpex, pref = g('pref_dividends_usd');
    const treasuryPretax = stakingUsd - corpOpex - pref;
    const treasuryAfterTax = afterTax(treasuryPretax, tax);
    const treasuryValue = treasuryAfterTax * g('treasury_multiple');
    // one-off value of the temporary tax shelter from losses carried forward (added once, not via a lower rate)
    const nolValue = g('nol_shelter_usd') ?? 0;
    const earningsPs = (treasuryValue + mavanValue + nolValue) / shares;
    const sotp = navPs + earningsPs;
    out[k] = {
      stakedShare, staked, yield: y, leak, ethGross, ethNet, stakingUsd,
      opex, corpOpex, pref, treasuryPretax, tax, treasuryAfterTax, treasuryMultiple: g('treasury_multiple'), treasuryValue, treasuryPs: treasuryValue / shares,
      mavanRev, mavanMargin, mavanPretax, mavanTax, mavanAfterTax, mavanMultiple: g('mavan_multiple'), mavanValue, mavanPs: mavanValue / shares,
      nolValue, nolPs: nolValue / shares,
      netIncome: treasuryAfterTax + mavanAfterTax,
      earningsPs, navPs, sotp, impliedMnav: sotp / navPs, upside: px.BMNR ? sotp / px.BMNR - 1 : null,
    };
  }
  return out;
}

/** Weekly staking estimate: ETH staked × annual yield × 7/365. */
export const weeklyStakingEth = (staked, annualYield, days = 7) => staked * annualYield * days / 365;

// Shared formulas (used by the browser page AND scripts/add-week.mjs).
// NAV, mNAV and valuation formulas (documented in README "NAV formulas").

/** NAV block. h = holdings.json, px = {ETH, BTC, BMNR, ORBS} prices in USD.
 * Claims senior to common: h.preferred.liquidation_usd (BMNP, $100 × shares) and h.debt_usd (none disclosed).
 * h.dilutive = [{ name, count, strike }] for the fully diluted (treasury-stock method) sensitivity row. */
export function computeNav(h, px) {
  const shares = h.shares_outstanding;
  // In-the-money equity-classified warrants (Strategic Advisor / Placement Agent / Representative), treasury-stock method
  // at this BMNR price: per-share figures use shares + these (h.warrants_tsm, counts from the latest filing).
  const tsm = dilutedShares(h.warrants_tsm, px.BMNR);
  const perShareShares = shares + tsm.added;
  // Liability-classified CVI warrants: Black-Scholes fair value at this BMNR price and date with the closest filing's inputs
  // (h.cvi_warrant); h.liabilities_usd is the other filed liabilities (excl. the CVI warrant liability).
  const cvi = cviWarrantValue(h.cvi_warrant, px.BMNR, px.date);
  const ethVal = h.eth * px.ETH;
  const btcVal = h.btc * px.BTC;
  const cash = h.cash_usd;
  const orbsVal = h.orbs.shares * px.ORBS;
  const beast = h.beast_usd;
  const other = h.other_assets_usd ?? 0; // balance-sheet assets the weekly releases don't cover (latest 10-K/10-Q carrying value)
  const pref = h.preferred?.liquidation_usd ?? 0;
  const debt = h.debt_usd ?? 0;
  const liab = (h.liabilities_usd ?? 0) + cvi.usd; // filed balance-sheet liabilities (latest 10-K/10-Q; CVI warrants revalued), excl. the mezzanine BMNP preferred
  const mcap = shares * px.BMNR;
  const mcapDiluted = perShareShares * px.BMNR;
  const full = btcVal + ethVal + cash + orbsVal + beast + other;
  const net = full - pref - debt - liab;
  const cryptoCash = btcVal + ethVal + cash;
  const ethOnly = ethVal;
  // Enterprise value = market cap + preferred + debt − cash, compared with the assets other than cash.
  const ev = mcapDiluted + pref + debt - cash;
  const navExCash = full - cash;
  const dil = dilutedShares(h.dilutive, px.BMNR);
  const row = (label, key, value, note, sh = perShareShares) => {
    const perShare = value / sh;
    return { label, key, value, perShare, mnav: px.BMNR / perShare, note };
  };
  const rows = [
    row('Full NAV', 'full', full, `BTC + ETH + cash + ORBS stake + Beast stake${other ? ' + other assets (10-K)' : ''} (gross: before the BMNP preferred)`),
    row('NAV net of preferred', 'net', net, `Full NAV − $${(pref / 1e6).toFixed(0)}M BMNP liquidation preference${debt ? ` − $${(debt / 1e6).toFixed(0)}M debt` : ''}${liab ? ` − $${(liab / 1e6).toFixed(1)}M liabilities (filed; CVI warrants $${(cvi.usd / 1e6).toFixed(2)}M at this price)` : ''}${tsm.added ? `; per share on ${(perShareShares / 1e6).toFixed(2)}M shares incl. ${(tsm.added / 1e6).toFixed(2)}M in-the-money warrant shares (TSM)` : ''}`),
    row('Crypto/Cash NAV', 'crypto', cryptoCash, 'BTC + ETH + cash'),
    row('ETHUSD NAV', 'eth', ethOnly, 'ETH only'),
    { label: 'EV ÷ NAV ex cash', key: 'ev', value: ev, perShare: null, mnav: ev / navExCash, navExCash,
      note: 'EV = market cap (shares incl. TSM warrant shares) + preferred + debt − cash; multiple = EV ÷ (Full NAV − cash)' },
  ];
  if (h.dilutive?.length) rows.push({ ...row('Fully diluted (TSM)', 'diluted', net, 'NAV net of preferred ÷ (shares + TSM warrant shares + treasury-stock-method shares from in-the-money options). Strike on 7,553 of the options is implied (about $19.40, from the 10-Q weighted average), not disclosed.', perShareShares + dil.added), sensitivity: true, dilution: dil });
  return { shares, perShareShares, tsm, tsmAdded: tsm.added, cvi, mcap, mcapDiluted, ethVal, btcVal, cash, orbsVal, beast, other, pref, debt, liab, full, net, ev, navExCash, dilution: dil, ethPerShare: h.eth / shares, rows };
}

const normCdf = (x) => { // Abramowitz–Stegun 7.1.26 erf (|error| < 1.5e-7)
  const z = Math.abs(x) / Math.SQRT2, t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + (x >= 0 ? erf : -erf));
};
/** Black-Scholes call (continuous dividend yield q). */
export function bsCall(S, K, T, r, vol, q = 0) {
  if (!(S > 0)) return 0;
  if (!(T > 0)) return Math.max(0, S - K);
  const sd = vol * Math.sqrt(T), d1 = (Math.log(S / K) + (r - q + vol * vol / 2) * T) / sd, d2 = d1 - sd;
  return S * Math.exp(-q * T) * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
}
/** Liability-classified CVI warrants: count × Black-Scholes value, term = expiry − date (years of 365 days). */
export function cviWarrantValue(c, price, date) {
  if (!c || !c.count) return { usd: 0 };
  const d = date ? Date.parse(String(date).slice(0, 10) + 'T00:00:00Z') : Date.now();
  if (c.issued && d < Date.parse(c.issued + 'T00:00:00Z')) return { usd: 0 };
  const T = (Date.parse(c.expiry + 'T00:00:00Z') - d) / (365 * 864e5);
  const per = bsCall(price, c.strike, T, c.rate, c.vol, c.div || 0);
  return { usd: Math.round(c.count * per), per_warrant: per, term_years: T, price, inputs_from: c.inputs_from };
}

/** Treasury-stock method: each in-the-money instrument adds count × (1 − strike ÷ price) shares. */
export function dilutedShares(list, price) {
  const items = (list || []).map((x) => ({ ...x, added: price > x.strike ? x.count * (1 - x.strike / price) : 0 }));
  return { added: items.reduce((t, x) => t + x.added, 0), items };
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
  const shares = nav.perShareShares ?? h.shares_outstanding; // same per-share basis as NAV (incl. TSM warrant shares)
  // NAV per share net of the BMNP liquidation preference: the preferred principal is deducted once, here.
  const netRow = nav.rows.find((r) => r.key === 'net') || nav.rows[0];
  const navPs = netRow.perShare;
  // 'principal' (default): preferred dividends are NOT also subtracted from earnings (their capitalized value ≈ the
  // principal, so deducting both would count the preferred twice). 'principal_and_dividends': also subtract the
  // dividends AFTER tax (they are not tax-deductible). Preferred dividends never reduce taxable income.
  const prefMode = V.preferred_treatment || 'principal';
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
    const corpOpex = opex - mavanCostInOpex;
    const prefDiv = g('pref_dividends_usd') ?? 0;
    const pref = prefMode === 'principal_and_dividends' ? prefDiv : 0; // after-tax deduction, alternative treatment only
    const treasuryPretax = stakingUsd - corpOpex; // preferred dividends are never a pre-tax deduction
    const treasuryAfterTax = afterTax(treasuryPretax, tax) - pref;
    const treasuryValue = treasuryAfterTax * g('treasury_multiple');
    // one-off value of the temporary tax shelter from losses carried forward (added once, not via a lower rate)
    const nolValue = g('nol_shelter_usd') ?? 0;
    const earningsPs = (treasuryValue + mavanValue + nolValue) / shares;
    const sotp = navPs + earningsPs;
    out[k] = {
      stakedShare, staked, yield: y, leak, ethGross, ethNet, stakingUsd,
      opex, corpOpex, pref, prefDiv, prefMode, prefPrincipal: nav.pref, treasuryPretax, tax, treasuryAfterTax, treasuryMultiple: g('treasury_multiple'), treasuryValue, treasuryPs: treasuryValue / shares,
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

/** Live BMNR price minus net NAV/share (the same NAV/share headline mNAV uses). */
export function priceMinusNav(price, navPerShare) {
  const diff = price - navPerShare;
  return { diff, pct: isFinite(navPerShare) && navPerShare !== 0 ? diff / navPerShare : null };
}

/** Signed dollar display, e.g. −$0.64 or +$1.20 (unicode minus). Rounded-to-zero has no sign. */
export function signedUsd(x, d = 2) {
  if (x == null || !isFinite(x)) return '—';
  const body = Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  if (/^0(\.0+)?$/.test(body.replace(/,/g, ''))) return '$' + (0).toFixed(d);
  return (x > 0 ? '+' : '−') + '$' + body;
}

/** Signed percent display, e.g. −3.6% or +5.2% (unicode minus). Rounded-to-zero has no sign. */
export function signedPct(x, d = 1) {
  if (x == null || !isFinite(x)) return '—';
  const body = (Math.abs(x) * 100).toFixed(d);
  if (/^0(\.0+)?$/.test(body)) return (0).toFixed(d) + '%';
  return (x > 0 ? '+' : '−') + body + '%';
}


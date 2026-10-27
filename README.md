# BMNR NAV / mNAV Tracker

Live site: **https://capeag.github.io/bmnr-nav-tracker/**

A static dashboard (plain HTML/CSS/JS + Chart.js from a CDN, no build step) that tracks the NAV, NAV per share and
mNAV of **Bitmine Immersion Technologies (NYSE: BMNR)** using:

* **Live ETH & BTC prices**, fetched in the browser from the free CoinGecko API on load and every 60 s
  (falls back to the last saved prices in `data/prices.json`, then to the last announcement's prices).
* **BMNR and ORBS quotes**, saved to `data/prices.json` by a GitHub Action every ~15 min during US market
  hours (Yahoo Finance chart endpoint, keyless; Stooq CSV as fallback). The page re-reads that file every 5 min.
* **Weekly holdings** from Bitmine's Monday-morning holdings releases, transcribed into `data/releases.json`; the
  week-by-week history (`data/history.json`) and latest balance sheet (`data/holdings.json`) are generated from it.

**Charts** (time range 1M / 3M / 6M / YTD / 1Y / All, applied to every chart): mNAV over time (with a 1.0× line);
NAV/share and BMNR close; estimated vs official shares outstanding with ETH held; **ETH per share** (reported ETH ÷ v3
estimated shares, official 10-Q weeks marked, week-over-week % bars); and the weekly accretion check ($ NAV/share and
ETH per 1,000 shares). Raw data tables sit under a **Show data ▸** toggle (collapsed by default); the backtest and the
methodology/notes sections are collapsed by default too. Explanatory notes for each chart/table live in
"Assumptions, methodology & notes" at the bottom so the cards stay clean. The layout is fluid up to 1760 px (cards and
charts in 2–3 columns on wide screens, one column on phones); wide tables scroll horizontally.

Every figure is rebuilt from Bitmine's own weekly releases and SEC filings since Nov 30, 2025: weekly inputs in
`data/releases.json`, official share counts / ATM sales / cash-flow figures from the 10-Qs in `data/checkpoints.json`.
The share-count model is **backtested out-of-sample** against every official count in 2026 (`data/backtest.json`,
"Model accuracy / backtest" section on the site).

## Files

| Path | What it is |
| --- | --- |
| `index.html`, `assets/style.css`, `assets/app.js` | The page. |
| `assets/calc.js` | NAV / mNAV / valuation formulas (shared by the page and the build script). |
| `data/releases.json` | **Official weekly inputs**, one entry per Bitmine Monday release since Nov 30, 2025 (ETH, ETH acquired, release ETH price, staked ETH, stated 7-day yield or CESR, BTC, cash (& marketable securities), Eightco and Beast stakes, buybacks, RSU/acquisition shares, disclosed investments (`investments_usd`), disclosed non-common proceeds, 8-K / X links). Also the disclosed cumulative buyback total. |
| `data/checkpoints.json` | **Official share counts** (10-Q balance sheets and cover pages) with links, ATM sales disclosed between them, and the 10-Q cash-flow figures used for the backtest and the cash-source analysis. |
| `data/backtest.json` | **Generated** out-of-sample backtest (models v1, v2, v3, v3 walk-forward + sensitivity variants) per interval, the 10-Q ETH price per quarter (`eth_price`), plus component diagnostics. |
| `data/weekly-prices.json` | Frozen market data per week (avg ETH, BTC close, BMNR avg/min/max/close) so past weeks don't drift. |
| `data/history.json` | **Generated** week-by-week reconstruction (shares, flows, NAV set, mNAV, weekly `accretion`). Don't edit by hand. |
| `data/holdings.json` | Latest balance sheet (generated fields) + assumptions (`assumptions.share_estimation` = model v3 parameters with sources; ORBS share count). |
| `data/valuation.json` | **Bear / Base / Bull valuation inputs**, each with sources and a rationale; `derived` (staked share, trailing 4/13/26-week yields, staked-ETH trajectory) is refreshed by the weekly build. |
| `data/prices.json` | Latest BMNR / ORBS (+ ETH, BTC) quotes, written by the Action. |
| `scripts/model.mjs` | The share-count estimator (weekly cash shortfall → share-funded amount → issuance, capped surplus carry-forward, roll-forward from an official count). |
| `data/onchain-purchases.json` | Bitmine-linked on-chain ETH receipts posted by trackers (Lookonchain etc.) — cross-check only, see below. |
| `scripts/build-history.mjs` | Rebuilds `history.json` (incl. the weekly accretion check), `backtest.json`, `holdings.json` and `valuation.json → derived` from `releases.json` + `checkpoints.json`. |
| `scripts/add-week.mjs` | Appends one release to `releases.json` and runs the build. |
| `scripts/fetch-prices.mjs` | Price fetcher used by the Action. |
| `.github/workflows/prices.yml` | Cron every 15 min 13:00–21:59 UTC Mon–Fri (+ hourly pre/after-hours) and manual dispatch; commits only when prices changed. |

## NAV formulas

* Full NAV = ETH×ETHUSD + BTC×BTCUSD + cash & marketable securities + Eightco stake (100,655,143 ORBS shares × price) + Beast stake ($180M)
* Crypto/Cash NAV = ETH + BTC + cash; ETH-only NAV = ETH
* Enterprise Value = market cap − cash (that row's "mNAV" = market cap ÷ EV)
* NAV/share = NAV ÷ estimated shares outstanding; mNAV = BMNR price ÷ NAV/share
* Valuation scenarios: see **Valuation (Bear / Base / Bull)** below; formulas in `assets/calc.js → computeValuation`, inputs in `data/valuation.json`.

## Valuation (Bear / Base / Bull)

Inputs live in `data/valuation.json` (edit there; the page recomputes with the live ETH price and current estimated share count).
`derived` values are refreshed from the weekly releases by `scripts/build-history.mjs`:
`staked_share_current` (staked ÷ held), `yield_trailing_4w/13w/26w` (averages of Bitmine's stated 7-day yields).

Method:

* Own staking (treasury) earnings = ETH held × staked share × gross staking yield × (1 − fee leakage) × live ETH price.
* Corporate costs = company cash opex run-rate (excl. stock comp and one-time items) − the part attributed to serving MAVAN clients (current MAVAN client revenue × (1 − MAVAN margin)) + BMNP preferred dividends.
* Treasury business value = (own staking earnings − corporate costs) × (1 − tax) × treasury multiple. Negative values are kept (costs above staking income destroy value).
* MAVAN third-party value = [existing client revenue × (1 − fee compression) + new client ETH AUM × network yield × take rate] × MAVAN margin × (1 − tax) × services multiple.
* SOTP per share = live Full NAV per share + (treasury value + MAVAN value) ÷ estimated shares. Implied mNAV = SOTP ÷ NAV per share.
* Option-premium income and interest are excluded in all cases: the ETH options program lost $133.3M in the 9 months to May 31, 2026 and cash balances (and interest) are being spent down (10-Q).

**No double counting:** NAV counts ETH already held, including staking rewards already received. The earnings value capitalizes only FUTURE net staking income on today's staked base, after costs, with no growth from future ETH purchases. Each week the rewards received move into NAV while the run-rate (and its capitalized value) stays the same, so no reward is counted twice at any point in time. Because a staked-ETH ETF (e.g. BlackRock ETHB) already passes staking yield to holders at ~1.0× NAV, the multiples on Bitmine's own staking income are kept modest — the premium is only for the yield being earned at scale net of costs.

| Input | Bear | Base | Bull | Why |
| --- | --- | --- | --- | --- |
| ETH staked (% of ETH held) | `staked_share_current` | 93% | 97% | Bear: stays at the current share (5,227,037 of 6,051,933 ETH = 86%). Bitmine's stated goal is "staking nearly all of Bitmine's remaining unstaked ETH" (Mar 25, 2026); base 93% (half the remaining gap closed, judgment), bull 97% (keeps ~3% liquid). [6] [2] |
| Gross staking yield (APR) | 2.25% | `yield_trailing_13w` | `yield_trailing_26w` | Base/bull use Bitmine's own stated 7-day yields (13- and 26-week trailing averages, refreshed weekly). Network APR is 2.46–2.6% today with ~35% of ETH staked and a 1.3–2.1M ETH entry queue; consensus rewards scale with 1/√(total stake), so a further ~20% rise in stake cuts yields ~9% → bear 2.25%. [6] [7] [8] [9] |
| Rewards paid away (advisory fee, partners, minority interest) | 8.5% | 3.5% | 3.5% | Since Sep 4, 2026 American Validator LLC receives 1.50% of rewards on Company-staked ETH, and Ethereum Tower owns 2% of MAVAN Holdings (base/bull = 3.5%). Bear adds 5% for ETH staked with outside "staking partners" at a Lido-node-operator-like fee. [4] [3] [10] |
| Company cash opex, annual (excl. stock comp, one-time items) | $150.5M | $119.0M | $96.1M | Base = Mar–May 2026 quarter × 4: G&A $37.27M − stock comp $13.25M + cost of sales $5.73M = $29.75M/qtr. Bear = management's 12-month cash requirements: ETH-management fees up to $50M + overhead $83.0M + working capital $12M + public-company $4M + capex $1.5M. Bull = cash G&A only ($24.02M/qtr × 4), assuming cost of sales is covered by MAVAN client revenue. Excludes $200.0M of one-time capital-raising/advisory fees (9 months). [1] |
| BMNP preferred dividends, annual | $33.2M | $33.2M | $33.2M | 3.5M shares of 9.50% Series A Perpetual Preferred; the 10-Q lists dividend obligations of ≈ $33.25M a year. Deducted from earnings (the preferred is not deducted from NAV). [1] |
| Cash tax rate on net income | 21% | 15% | 10% | Staking rewards are taxable income when received (Rev. Rul. 2023-14); bear uses the 21% federal rate. Base/bull assume operating losses (G&A $335.7M in the 9 months to May 31, 2026) shelter part of near-term income (judgment). [18] [1] |
| Multiple on net treasury/staking earnings | 6× | 15× | 18.8× | Bear 6× = Lido DAO's treasury-adjusted revenue multiple (staking-protocol comp). Base 15× = money-center banks' market cap ÷ net income (balance-sheet yield businesses). Bull 18.8× = asset managers' forward P/E. Kept below asset-manager levels because staked-ETH ETFs offer the same yield at ~1.0× NAV. [14] [15] [17] |
| MAVAN client revenue run-rate (today) | $18.9M | $18.9M | $18.9M | Pier Two (now MAVAN) contributed $3.527M of staking revenue from its Mar 24 acquisition to May 31, 2026 (68 days) → $18.9M a year, on about $2B of client assets across ETH, Solana, Hyperliquid and Canton (Tom Lee, May 2026). [1] [5] |
| Fee compression on existing clients | 25% | 0% | 0% | Institutional commissions are compressing (Messari); bear cuts existing revenue by a quarter. [12] |
| New client ETH staked via MAVAN | $0 | $2,000.0M | $6,000.0M | From ~$2B of client assets in May 2026: bear no growth; base doubles to $4B; bull reaches $8B (MAVAN pitches itself as the largest Ethereum staking platform; judgment). [5] [2] |
| Fee on new client rewards | 5% | 8% | 10% | Institutional range 5–10% of rewards (Messari); Coinbase Prime and Lido charge 10%. [12] [11] [10] |
| MAVAN segment operating margin | 15% | 25% | 40% | Base = US asset managers' pre-tax operating margin (25.2%); bear/bull ±10–15 pts (judgment; MAVAN is not reported as a segment). [16] |
| Multiple on MAVAN after-tax earnings | 8.5× | 18.8× | 24.8× | Bear 8.5× = LDO market cap ÷ annualized protocol revenue. Base 18.8× = asset managers' forward P/E. Bull 24.8× = asset managers' market cap ÷ net income. [13] [15] |

Cases — **Bear:** Yields compress as the network stake keeps rising, part of the ETH stays with paid outside partners, costs run at the top of management's guidance, MAVAN wins no new clients and faces fee pressure, and the market pays only a protocol-token multiple. **Base:** Today's business at its current run-rate: 13-week average Bitmine yield, staking moves toward "nearly all" ETH, 10-Q cost run-rate, MAVAN doubles client assets at a typical institutional fee, and financial-sector multiples. **Bull:** Staking near-complete with the 26-week yield (MEV upside), leaner costs, MAVAN quadruples client assets at Coinbase-Prime/Lido-level fees, net operating losses shelter part of the tax, and asset-manager multiples.

Sources:

1. [10-Q for quarter ended May 31, 2026 (filed Jul 14, 2026)](https://www.sec.gov/Archives/edgar/data/1829311/000162828026048157/bmnr-20260531.htm)
2. [8-K Ex. 99.1, Mar 25, 2026 — MAVAN launch](https://www.sec.gov/Archives/edgar/data/1829311/000149315226012549/ex99-1.htm)
3. [8-K, Mar 30, 2026 — Pier Two acquisition & Ethereum Tower MSA](https://www.sec.gov/Archives/edgar/data/1829311/000149315226013609/form8-k.htm)
4. [8-K, Sep 8, 2026 — MSA terminated; American Validator fee 1.50% of rewards](https://www.sec.gov/Archives/edgar/data/1829311/000149315226041713/form8-k.htm)
5. [8-K Ex. 99.2, May 11, 2026 — Tom Lee remarks ("staking about $2 billion of client assets")](https://www.sec.gov/Archives/edgar/data/1829311/000149315226022150/ex99-2.htm)
6. [8-K Ex. 99.1, Oct 26, 2026 — weekly update (5,227,037 staked ETH; 2.58% 7-day yield; $318M annualized)](https://www.sec.gov/Archives/edgar/data/1829311/000149315226048429/ex99-1.htm)
7. [validatorqueue.com (beaconcha.in data), Oct 26, 2026 — network APR 2.6%, 35.0% of supply staked, entry queue ~2.1M ETH](https://validatorqueue.com/)
8. [TokenPost staking weekly (Dune), Oct 26, 2026 — APR 2.46–2.47% Oct 18–25; 43.94M ETH staked (35.2%)](https://www.tokenpost.com/news/investing/41001)
9. [CryptoKeyhole, Oct 26, 2026 — consensus-layer rewards scale with 1/√(total stake); entry queue 1.26M ETH](https://cryptokeyhole.com/ethereum-staking/)
10. [Lido — protocol fee 10% of rewards (5% node operators / 5% DAO)](https://lido.fi/how-lido-works/protocol-fee)
11. [Coinbase Prime staking fees — 10% of ETH rewards (retail: 35%, 25.25–31.75% for Coinbase One)](https://help.coinbase.com/en/prime/staking/fees)
12. [Messari, The Institutional Staking Landscape — institutional commissions typically 5–10% of rewards, compressing](https://messari.io/report/the-institutional-staking-landscape)
13. [Digital Asset Database — LDO market cap ≈ 8.5× annualized protocol revenue (Oct 2026)](https://digitalassetdatabase.com/assets/lido-dao/valuation)
14. [Lido DAO LTM dashboard (Dune) — 6.05× treasury-adjusted LTM revenue multiple (Aug 2026)](https://dune.com/bcvfinance/lido-dao-ltm-financial-and-governance-dashboard)
15. [Damodaran, PE by sector (US, Jan 2026): Bank (Money Center) mkt cap/NI 14.99×; Investments & Asset Mgmt forward PE 18.77×, mkt cap/NI 24.80×](https://pages.stern.nyu.edu/~adamodar/New_Home_Page/datafile/pedata.html)
16. [FinObservatory (Damodaran data) — US Investments & Asset Mgmt pre-tax operating margin 25.2%](https://finobservatory.org/valuation/industry/investments-asset-management)
17. [iShares Staked Ethereum Trust ETF (ETHB) — passes net staking rewards to ETF holders](https://www.blackrock.com/us/individual/products/348532/ishares-staked-ethereum-trust-etf)
18. [IRS Rev. Rul. 2023-14 — staking rewards are gross income when received](https://www.irs.gov/pub/irs-drop/rr-23-14.pdf)

## Weekly accretion check

Computed for every week in `scripts/build-history.mjs` (`history.json → snapshots[].accretion`), using the v3 model's
estimated issuance (so everything is an estimate):

* NAV/share before the week's actions = last week's assets with ETH revalued at the week's average ETH price.
* **ATM issuance** = est. shares sold × (week's average BMNR close − NAV/share before) ÷ shares after — positive only when
  sold above NAV (mNAV > 1).
* **Buybacks** = shares bought × (NAV/share before − buyback price) ÷ shares after.
* **Staking** = est. rewards × ETH price ÷ shares. **Other** = −(cash opex + BMNP dividends + cash paid above the week's
  average ETH price) ÷ shares. "Market move" (price changes) is reported separately and is not a capital action.
* **ETH per share**: change = capital actions (ETH the week's cash could buy at the average price − dilution from net new
  shares) + staking rewards ÷ shares + premium (ETH lost by paying above the average price) + 10-Q re-anchor true-ups.
  The parts add up exactly to the week's ETH/share change.
* The page sums the weeks inside the selected range (1M … All) and shows last week as a headline card.

## Share-count reconstruction

Bitmine does not disclose weekly ATM sales or a running share count. Official counts come only from 10-Q/10-K filings:

| Date | Shares | Source |
| --- | --- | --- |
| Nov 30, 2025 | 408,578,823 | [10-Q Nov 30, 2025](https://www.sec.gov/Archives/edgar/data/1829311/000149315226002084/form10-q.htm) balance sheet (trade-date basis; later revised to 405,398,823 settlement-date) |
| Jan 12, 2026 | 454,862,451 | same 10-Q, cover page (+46,169,850 ATM shares Dec 1–Jan 12, $1.516B gross) |
| Feb 28, 2026 | 493,905,227 | [10-Q Feb 28, 2026](https://www.sec.gov/Archives/edgar/data/1829311/000149315226016560/form10-q.htm) balance sheet |
| Apr 13, 2026 | 537,628,819 | same 10-Q, cover page — **flagged**: contradicts the filing's own Feb 28 count + 57,107,586 ATM shares sold through Apr 14 (= 551.0M); not used as an anchor |
| May 31, 2026 | 579,652,432 | [10-Q May 31, 2026](https://www.sec.gov/Archives/edgar/data/1829311/000162828026048157/bmnr-20260531.htm) balance sheet |
| Jul 9, 2026 | 603,226,394 | same 10-Q, cover page (latest) |

Between anchors, for each weekly release *t* (window = day after the previous as-of date through this as-of date), **model v3**:

| Step | Formula / rule |
| --- | --- |
| Est. staking rewards | `min(ETH staked over the last 5 reports) × stated 7-day BMNR yield (CESR if none) × days / 365` — i.e. only ETH staked ≥ 4 reports earlier earns (validator entry queue). Fitted to 10-Q staking revenue: $55.6M modelled vs $52.5M reported for Dec–May (no lag gave $80.0M). |
| Est. ETH bought | `ETH held_t − ETH held_{t−1} − rewards` (the 10-Q digital-asset roll-forward adds staking rewards to ETH units) |
| ETH price paid (basis per week) | **disclosed**: week inside a quarter with a filed 10-Q → `average daily ETH price in the window × that quarter's paid ÷ market ratio`. **assumed**: after the last filed quarter → `window average × pooled ratio (0.9979)`, low–high ±1%. **on-chain**: tracker prices, only if `use_onchain_price` is switched on (it is off — see below). A release that states the dollars spent on ETH (`eth_purchase_cost_usd`) would be used as disclosed for that week. |
| Other digital-asset cash (10-Q) | cash paid for digital assets beyond the cost of ETH added (cash-flow statement vs roll-forward): $124.6M in Dec–Feb (Sep–Nov purchases paid later) and $112.2M in Mar–May (unexplained), spread over that quarter's weeks by ETH bought (`checkpoints.json → eth_cost_quarterly.cash_timing_items`). None assumed after May 31, 2026. |
| Buyback cost | `shares × disclosed avg price`; else `shares × window avg BMNR close × k`, k calibrated to the disclosed total ($399.6M / 22.9M shares; k ≈ 1.005) |
| Disclosed investments | cash for non-ETH investments named in the release (Beast $200M wk of Jan 25; Eightco ~$80M wk of Mar 15; Pier Two ~$6M wk of Mar 29) |
| Operating cash burn | `$2,278,000/week` = Dec 2025–May 2026 net operating cash flow (−$59.236M ÷ 26, 10-Qs) **plus** `$646,450/week` BMNP dividends from Jun 10, 2026; prorated by days |
| Cash shortfall | `spending − cash drop − disclosed non-common proceeds (BMNP $273.8M)`, spending = ETH cost + other digital-asset cash + buyback cost + investments + operating burn. Negative = surplus. |
| Surplus carry-forward | a surplus offsets the next weeks' shortfalls for at most **3 weeks** and **$5M in total** (oldest used first; anything older or above the cap is dropped). Noise-sized on purpose: cash in releases is rounded to the nearest $1M since Jan 4, 2026, and the ETH price assumption alone is ±1% (≈ ±$0.2M/week at current purchase sizes). |
| Funded by share sales (est.) | `max(0, shortfall − surplus used)` |
| Est. shares issued | `funded ÷ window average BMNR close` |
| Shares outstanding | `anchor + Σ issued + RSU/acquisition shares − buybacks`; the week containing a new official count is re-based on it (issuance after that date only, by trading days) |
| Low–high est. | low: operating burn = 0, ETH price −1% (assumed weeks only) and issue at the window's highest close; high: 2× burn, ETH price +1% and the window's lowest close. Shares-outstanding ranges accumulate from the last official count (Jul 9, 2026). |

### What Bitmine pays for ETH

The 10-Q digital-asset notes give ETH units held and the cost of ETH purchased, so the average price actually paid per
quarter can be compared with the market (`checkpoints.json → eth_cost_quarterly`, `backtest.json → eth_price`):

| Fiscal quarter | ETH bought | Cost | Paid / ETH | Market avg (purchase-weighted weekly avg) | Paid ÷ market | Cash paid (cash-flow stmt.) |
| --- | --- | --- | --- | --- | --- | --- |
| Sep–Nov 2025 ([10-Q](https://www.sec.gov/Archives/edgar/data/1829311/000149315226002084/form10-q.htm)) | 1,861,886 | $7,527.2M | $4,043 | $4,052 | 0.998 | $7,402.6M |
| Dec 2025–Feb 2026 ([10-Q](https://www.sec.gov/Archives/edgar/data/1829311/000149315226016560/form10-q.htm)) | 732,539 | $2,009.4M | $2,743 | $2,768 | 0.991 | $2,134.4M |
| Mar–May 2026 ([10-Q](https://www.sec.gov/Archives/edgar/data/1829311/000162828026048157/bmnr-20260531.htm)) | 923,853 | $2,036.5M | $2,204 | $2,192 | 1.006 | $2,150.5M |
| Pooled | 3,518,278 | $11,573.2M | $3,289 | | **0.998** | $11,687.5M |

* Bitmine pays the market average to within about ±1% each quarter; there is no markup and no trend as purchases got
  smaller. v2's 1.05 factor was fitted to the cash-flow statement, which mixes price with settlement timing
  (Sep–Nov purchases paid in Dec–Feb, and $112M more cash than ETH added in Mar–May); v3 keeps the two apart.
* No 10-K for the fiscal year ended Aug 31, 2026 is on EDGAR yet (checked Oct 27, 2026). When it lands, add Jun–Aug
  2026 as a quarter (12-month − 9-month figures) and any cash-timing gap; those weeks then become "disclosed".
* Q1 market average uses the Sep–Nov 2025 weekly 8-K holdings and Yahoo Finance daily ETH closes (computed once,
  stored in `checkpoints.json`); Q2/Q3 use the frozen weekly prices in `weekly-prices.json`. Staking units in Q1/Q2
  are estimated from the staking $ ÷ average price (~4k ETH; the 9-month total of 23,582 is exact).

**On-chain trackers.** Lookonchain, OnchainLens, EmberCN and others post Bitmine-linked wallets receiving ETH from
FalconX, BitGo, Kraken, Galaxy etc. 50 such transfers since Dec 2025 are in `data/onchain-purchases.json`. Since Jul 9,
2026 there are 10 transfers in 8 of 16 weeks, and their amounts match the week's reported purchase within ±20% in only
2 (Jul 19, Oct 11). The dollar figures are the trackers' spot valuations at withdrawal, not trade prices (except two
Ethereum Foundation OTC sales), and withdrawals usually come after the trades (often after the week closes). Pricing
the tracked part of each week at those figures made the Dec–Feb quarterly cost error worse (+1.35–1.58% vs +0.97%
with the weekly average) and Mar–May no better (−0.55–0.74% vs −0.55%), with dated daily prices no better either.
So they are shown as an "on-chain check" in the data table only. Treat every tracker attribution as probable, not certain.

**Model v2** (Jul–Oct 2026, before this revision): ETH at weekly average × 1.05, unlimited surplus carry-forward, no
ETH-price range. **Model v1** (before the first backtest): rewards on all ETH staked at the previous report, ETH at the plain weekly average price, $3,257,538/week opex (Mar–May G&A − SBC + cost of sales ÷ 13), no
investments term, each week floored at zero issuance.

### Backtest (out-of-sample, estimate − official)

Each interval starts at an official count and rolls forward using only the weekly releases; `node scripts/build-history.mjs` prints and saves it.

| Interval | Official Δ | v1 error | v2 error | v3 error | v3 walk-forward |
| --- | --- | --- | --- | --- | --- |
| Nov 30 → Jan 12 | +46.28M | −0.82M (−0.18%) | +1.16M (+0.26%) | +1.21M (+0.27%) | +1.50M (+0.33%) |
| Jan 12 → Feb 28 | +39.04M | −2.93M (−0.59%) | −0.41M (−0.08%) | −0.35M (−0.07%) | −0.15M (−0.03%) |
| Feb 28 → May 31 (quarter) | +85.75M | −7.62M (−1.31%) | +0.38M (+0.07%) | +1.47M (+0.25%) | −4.36M (−0.75%) |
| May 31 → Jul 9 | +23.57M | −0.66M (−0.11%) | +0.62M (+0.10%) | −1.23M (−0.20%) | −1.23M (−0.20%) |
| Nov 30 → Jul 9 (no re-anchoring) | +194.65M | −12.03M (−1.99%) | +1.76M (+0.29%) | +1.09M (+0.18%) | −4.25M (−0.70%) |
| *Feb 28 → Apr 13 (flagged cover)* | +43.72M | −3.18M | +2.85M | +3.32M | +0.63M |
| *Apr 13 → May 31 (flagged cover)* | +42.02M | −4.44M | −2.46M | −1.85M | −5.04M |

Four clean intervals — mean |error| / bias: **v1 0.55% / −0.55%**, **v2 0.13% / +0.09%**, **v3 0.20% / +0.06%**,
v3 walk-forward 0.33% / −0.16%. v2 and v3 both use Dec–May 10-Q data (in-sample on those rows); v3's walk-forward only
knows 10-Qs filed before each interval starts, so it misses the Mar–May cash-timing item in the Feb 28 → May 31 test.
v2's lower error comes from a factor that mixes ETH price with cash timing; it would overstate what Bitmine pays per
ETH by ~5% in every week. Surplus carry-forward rules barely matter (no carry 0.19%, 3 wk/$5M 0.20%, unlimited 0.20%;
current estimate 626.86M vs 626.77M). Sub-quarter errors are mostly *timing* (which days inside a week the ATM sold,
when ETH purchases settled) and rounded cash figures in some releases ("$1.0 billion", "$1.2 billion" → ±$50M ≈ ±2M shares).

Current estimate (Oct 25, 2026): **v3 626,766,979** (low–high est. since the Jul 9 official count 621.9–632.2M);
v2 was 627,963,701 (623.1–633.4M).

## Weekly update procedure (Mondays, after Bitmine posts)

1. Open the release: **[@BitMNR](https://x.com/BitMNR)** thread "BitMine provided its latest holdings update for …" (~8:30 AM ET),
   the PR Newswire release it links, and the 8-K (Ex. 99.1) on
   [SEC EDGAR, CIK 1829311](https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001829311&type=8-K) (use the 8-K as the source of record).
2. Read off: as-of date, total ETH, "we acquired N ETH", ETH price used, BTC, Beast stake, Eightco stake $,
   total cash & marketable securities, total staked ETH, stated 7-day BMNR yield, buybacks (shares + avg price), and any
   disclosed share issuance, proceeds, or share count. Also check EDGAR for new 10-K/10-Q/10-KT (cover-page share count),
   424B/S-3 filings and Form 4s (RSU vesting adds shares).
3. Run:

   ```bash
   node scripts/add-week.mjs --date 2026-11-02 --asof 2026-11-01 \
     --eth <total ETH> --acquired <N> --eth-price <release ETH price> --staked <staked ETH> --yield <0.0258> \
     --btc <BTC> --cash <USD> --orbs-value <Eightco $> --beast 180000000 \
     [--buyback-shares <n> --buyback-price <avg>] [--other-shares <RSUs>] \
     [--shares-issued <n>] [--proceeds <USD>] [--eth-cost <USD>] [--shares-outstanding <official count>] \
     --sec "<8-K Ex.99.1 URL>" --x "<@BitMNR post URL>" --notes "<anything unusual>"
   ```

   If the release states a new cumulative buyback total, update `buyback_aggregate` in `data/releases.json` too.
   If a release ever states the dollars spent on ETH, pass `--eth-cost <USD>` (that week's ETH price becomes "disclosed").
   Optional cross-check: add any tracker posts of Bitmine-linked OTC/exchange withdrawals that week (Lookonchain,
   OnchainLens, EmberCN on X) to `data/onchain-purchases.json` (`time_utc`, `eth`, `usd`, `source`); they are shown,
   not used for the price.
   If the release discloses cash spent on a new investment/acquisition, pass `--investments <USD>`; for preferred or
   other non-common proceeds pass `--proceeds <USD>`.
   When an official share count appears (e.g. the FY-Aug-2026 10-K cover), pass `--shares-outstanding <n> --cp-date <date>
   --cp-source "10-K cover page" --cp-url <URL>` (or add it to `data/checkpoints.json`); the estimate re-anchors there.
   Also add any ATM sales the filing discloses to `checkpoints.json → atm_disclosures` and re-run the build: the backtest
   will show how far the model was off for the new interval. For a new 10-Q/10-K, also add the quarter's ETH cost to
   `checkpoints.json → eth_cost_quarterly.quarters` (units purchased, cost of ETH purchased, cash paid for digital
   assets; year-to-date figures minus the previous filing) and, if cash paid ≠ cost of digital assets added, a
   `cash_timing_items` entry. Weeks in that quarter switch from "assumed" to "disclosed" and the pooled factor updates.
4. Check the printed table and the "This week" card: ETH price paid + basis, cash shortfall (spending − cash drop),
   surplus carried from prior weeks (max 3 weeks / $5M), funded by share sales, shares issued (low–high est.). The build also refreshes `valuation.json → derived` and each week's accretion. Then
   `git add data && git commit -m "week of <date>" && git push`. Pages redeploys in ~1 min.
   Review `data/valuation.json` inputs when a new 10-Q/10-K is filed (opex run-rate, MAVAN revenue, preferred dividends).

## Notes / caveats

* **Shares outstanding** between official counts is an estimate with a range (see above); after July 9, 2026 it is entirely estimated. The fiscal year-end changes from Aug 31 to Dec 31 after FY2026; expect a 10-K (FY ended Aug 31, 2026) and later a 10-KT.

* **ORBS** = Eightco Holdings (NASDAQ: ORBS) **stock** — not the "Orbs" crypto token on CoinGecko. 100,655,143 shares per
  Bitmine's 10-Q; weekly snapshots use the reported $ value, the live page uses shares × live price.
* Beast Industries is carried at the disclosed $180M. BMNP preferred and other liabilities are not deducted.
* GitHub cron schedules can run late or be skipped under load; the page always shows each price's timestamp.

Not investment advice.

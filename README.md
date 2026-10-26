# BMNR NAV / mNAV Tracker

Live site: **https://capeag.github.io/bmnr-nav-tracker/**

A static dashboard (plain HTML/CSS/JS + Chart.js from a CDN, no build step) that tracks the NAV, NAV per share and
mNAV of **Bitmine Immersion Technologies (NYSE: BMNR)** using:

* **Live ETH & BTC prices**, fetched in the browser from the free CoinGecko API on load and every 60 s
  (falls back to the last saved prices in `data/prices.json`, then to the last announcement's prices).
* **BMNR, ETHA and ORBS quotes**, saved to `data/prices.json` by a GitHub Action every ~15 min during US market
  hours (Yahoo Finance chart endpoint, keyless; Stooq CSV as fallback). The page re-reads that file every 5 min.
* **Weekly holdings** from Bitmine's Monday-morning holdings releases, transcribed into `data/releases.json`; the
  week-by-week history (`data/history.json`) and latest balance sheet (`data/holdings.json`) are generated from it.

**Weekly history charts** (time range 1M / 3M / 6M / YTD / 1Y / All): mNAV, NAV/share and BMNR close; estimated vs
official shares outstanding with ETH held; and **ETH per share** (reported ETH ÷ v2 estimated shares, official 10-Q
weeks marked) with week-over-week % change bars — the weekly accretion check (positive = ETH grew faster than the share
count). The layout is fluid up to 1760 px: cards and charts flow into 2–3 columns on wide screens, one column on phones;
wide tables scroll horizontally.

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
| `data/backtest.json` | **Generated** out-of-sample backtest (model v1 vs v2 vs walk-forward) per interval, plus component diagnostics. |
| `data/weekly-prices.json` | Frozen market data per week (avg ETH, BTC close, BMNR avg/min/max/close) so past weeks don't drift. |
| `data/history.json` | **Generated** week-by-week reconstruction (shares, flows, NAV set, mNAV). Don't edit by hand. |
| `data/holdings.json` | Latest balance sheet (generated fields) + assumptions (`assumptions.share_estimation` = model v2 parameters with sources; valuation scenario inputs; ORBS share count). |
| `data/prices.json` | Latest BMNR / ETHA / ORBS (+ ETH, BTC) quotes, written by the Action. |
| `scripts/model.mjs` | The share-count estimator (weekly cash need → implied issuance, roll-forward from an official count). |
| `scripts/build-history.mjs` | Rebuilds `history.json`, `backtest.json` and `holdings.json` from `releases.json` + `checkpoints.json`. |
| `scripts/add-week.mjs` | Appends one release to `releases.json` and runs the build. |
| `scripts/fetch-prices.mjs` | Price fetcher used by the Action. |
| `.github/workflows/prices.yml` | Cron every 15 min 13:00–21:59 UTC Mon–Fri (+ hourly pre/after-hours) and manual dispatch; commits only when prices changed. |

## NAV formulas

* Full NAV = ETH×ETHUSD + BTC×BTCUSD + cash & marketable securities + Eightco stake (100,655,143 ORBS shares × price) + Beast stake ($180M)
* Crypto/Cash NAV = ETH + BTC + cash; ETH-only NAV = ETH
* Enterprise Value = market cap − cash (that row's "mNAV" = market cap ÷ EV)
* NAV/share = NAV ÷ estimated shares outstanding; mNAV = BMNR price ÷ NAV/share
* Valuation scenarios (staking, MAVAN, SOTP): see `assets/calc.js`; inputs in `holdings.json → assumptions.valuation`.

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

Between anchors, for each weekly release *t* (window = day after the previous as-of date through this as-of date), **model v2**:

| Step | Formula / rule |
| --- | --- |
| Est. staking rewards | `min(ETH staked over the last 5 reports) × stated 7-day BMNR yield (CESR if none) × days / 365` — i.e. only ETH staked ≥ 4 reports earlier earns (validator entry queue). Fitted to 10-Q staking revenue: $55.6M modelled vs $52.5M reported for Dec–May (no lag gave $80.0M). |
| Est. ETH bought | `ETH held_t − ETH held_{t−1} − rewards` (the 10-Q digital-asset roll-forward adds staking rewards to ETH units) |
| ETH purchase cost | `ETH bought × average daily ETH price in the window × 1.05`. The 10-Q cash paid for ETH ran 3.5% (Dec–Feb) and 6.5% (Mar–May) above "ETH added × weekly average price". |
| Buyback cost | `shares × disclosed avg price`; else `shares × window avg BMNR close × k`, k calibrated to the disclosed total ($399.6M / 22.9M shares; k ≈ 1.005) |
| Disclosed investments | cash for non-ETH investments named in the release (Beast $200M wk of Jan 25; Eightco ~$80M wk of Mar 15; Pier Two ~$6M wk of Mar 29) |
| Operating cash burn | `$2,278,000/week` = Dec 2025–May 2026 net operating cash flow (−$59.236M ÷ 26, 10-Qs) **plus** `$646,450/week` BMNP dividends from Jun 10, 2026; prorated by days |
| Cash need | `Δcash + ETH cost + buyback cost + investments + operating burn − disclosed non-common proceeds (BMNP $273.8M)` |
| Est. shares issued | `cash need ÷ window average BMNR close`; a negative week is carried forward as surplus against later weeks |
| Shares outstanding | `anchor + Σ issued + RSU/acquisition shares − buybacks`; the week containing a new official count is re-based on it (issuance after that date only, by trading days) |
| Range | low: operating burn = 0 and issue at the window's highest close; high: 2× burn and issue at the window's lowest close |

**Model v1** (used for the Jul–Oct 2026 reconstruction before the backtest): rewards on all ETH staked at the previous
report, ETH at the plain weekly average price, $3,257,538/week opex (Mar–May G&A − SBC + cost of sales ÷ 13), no
investments term, each week floored at zero issuance.

### Backtest (out-of-sample, estimate − official)

Each interval starts at an official count and rolls forward using only the weekly releases; `node scripts/build-history.mjs` prints and saves it.

| Interval | Official Δ | v1 error | v2 error | v2 walk-forward |
| --- | --- | --- | --- | --- |
| Nov 30 → Jan 12 | +46.28M | −0.82M (−0.18%) | +1.16M (+0.26%) | +0.53M (+0.12%) |
| Jan 12 → Feb 28 | +39.04M | −2.93M (−0.59%) | −0.41M (−0.08%) | −0.85M (−0.17%) |
| Feb 28 → May 31 (quarter) | +85.75M | −7.62M (−1.31%) | +0.38M (+0.07%) | −1.06M (−0.18%) |
| May 31 → Jul 9 | +23.57M | −0.66M (−0.11%) | +0.62M (+0.10%) | +0.08M (+0.01%) |
| Nov 30 → Jul 9 (no re-anchoring) | +194.65M | −12.03M (−1.99%) | +1.76M (+0.29%) | −1.29M (−0.21%) |
| *Feb 28 → Apr 13 (flagged cover)* | +43.72M | −3.18M | +2.85M | +2.21M |
| *Apr 13 → May 31 (flagged cover)* | +42.02M | −4.44M | −2.46M | −3.28M |

Mean |error| on the four clean intervals: **v1 0.55% (3.0M shares) → v2 0.13% (0.64M shares)**; walk-forward 0.12%.
v2's ETH-cost, staking-lag and opex parameters were fitted on Dec–May 10-Q data, so those rows are partly in-sample;
the walk-forward variant fits the ETH-cost factor on Dec–Feb only (1.035) and is out-of-sample from March. Errors on
individual sub-quarter intervals are mostly *timing* (which days inside a week the ATM sold) and rounded cash figures
in some releases ("$1.0 billion", "$1.2 billion" → ±$50M ≈ ±2M shares).

### Non-dilutive cash sources (10-Q cash-flow statements, Dec 1, 2025 – May 31, 2026)

| Item | Amount | Note |
| --- | --- | --- |
| ATM common stock | +$4,205M | 172.2M shares; ~97% of all cash raised |
| Staking | $52.5M revenue, **non-cash** | received in ETH and kept (ETH sold: $0.24M in 9 months) |
| ETH options | +$103.9M premiums received | −$124.6M premiums paid, −$100.1M collateral posted; net loss on derivatives −$133.3M (9 months) |
| Interest income | ≈ +$10.1M | |
| Asset sales, warrant exercises | ≈ +$2.5M | |
| Debt / convertibles | $0 | |
| Net operating cash flow | −$59.2M | |
| BMNP 9.50% preferred (Jun 10, 2026) | +$273.8M net | only material non-dilutive raise of 2026 |

Conclusion: no evidence of a material undisclosed cash source; v1's under-estimate came from missing cash *uses*
(disclosed investments, ETH cost above the weekly average, overstated staking), all now in v2. Jul–Oct 2026 can be
checked only when the next 10-K / 10-KT is filed.

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
     [--shares-issued <n>] [--proceeds <USD>] [--shares-outstanding <official count>] \
     --sec "<8-K Ex.99.1 URL>" --x "<@BitMNR post URL>" --notes "<anything unusual>"
   ```

   If the release states a new cumulative buyback total, update `buyback_aggregate` in `data/releases.json` too.
   If the release discloses cash spent on a new investment/acquisition, pass `--investments <USD>`; for preferred or
   other non-common proceeds pass `--proceeds <USD>`.
   When an official share count appears (e.g. the FY-Aug-2026 10-K cover), pass `--shares-outstanding <n> --cp-date <date>
   --cp-source "10-K cover page" --cp-url <URL>` (or add it to `data/checkpoints.json`); the estimate re-anchors there.
   Also add any ATM sales the filing discloses to `checkpoints.json → atm_disclosures` and re-run the build: the backtest
   will show how far the model was off for the new interval.
4. Check the printed table, then `git add data && git commit -m "week of <date>" && git push`. Pages redeploys in ~1 min.

## Notes / caveats

* **Shares outstanding** between official counts is an estimate with a range (see above); after July 9, 2026 it is entirely estimated. The fiscal year-end changes from Aug 31 to Dec 31 after FY2026; expect a 10-K (FY ended Aug 31, 2026) and later a 10-KT.

* **ORBS** = Eightco Holdings (NASDAQ: ORBS) **stock** — not the "Orbs" crypto token on CoinGecko. 100,655,143 shares per
  Bitmine's 10-Q; weekly snapshots use the reported $ value, the live page uses shares × live price.
* Beast Industries is carried at the disclosed $180M. BMNP preferred and other liabilities are not deducted.
* GitHub cron schedules can run late or be skipped under load; the page always shows each price's timestamp.

Not investment advice.

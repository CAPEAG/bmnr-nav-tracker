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

The formulas replicate the shared Google Sheet's `BMNR` tab cell-for-cell (see `assets/calc.js`; verified to
reproduce the sheet's Full NAV $14,920,334,556, NAV/share $23.71, mNAV 0.922, EV mNAV 1.051 and SOTP $25.92 / $26.52 / $26.70
from the sheet's own inputs). The **data** no longer comes from the sheet: every figure is rebuilt from Bitmine's own
releases and SEC filings since the July 9, 2026 official share count (see below).

## Files

| Path | What it is |
| --- | --- |
| `index.html`, `assets/style.css`, `assets/app.js` | The page. |
| `assets/calc.js` | NAV / mNAV / valuation formulas (shared by the page and the build script). |
| `data/releases.json` | **Official inputs**, one entry per Bitmine Monday release since July 2026 (ETH, ETH acquired, release ETH price, staked ETH, stated 7-day yield, BTC, cash & marketable securities, Eightco and Beast stakes, buybacks, RSU vesting, any disclosed issuance/proceeds/official share count, 8-K / X links). Also the share-count anchor and the disclosed cumulative buyback total. |
| `data/weekly-prices.json` | Frozen market data per week (avg ETH, BTC close, BMNR avg/min/max/close) so past weeks don't drift. |
| `data/history.json` | **Generated** week-by-week reconstruction (shares, flows, NAV set, mNAV). Don't edit by hand. |
| `data/holdings.json` | Latest balance sheet (generated fields) + assumptions (staking yield, cash-cost estimate, valuation scenario inputs, ORBS share count). |
| `data/prices.json` | Latest BMNR / ETHA / ORBS (+ ETH, BTC) quotes, written by the Action. |
| `scripts/build-history.mjs` | Rebuilds `history.json` + `holdings.json` from `releases.json`. |
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

Bitmine does not disclose weekly share issuance (ATM sales) or a running share count. The last official count is
**603,226,394 shares on July 9, 2026** (cover of the 10-Q for the quarter ended May 31, 2026). From there, for each
weekly release *t* (window = day after the previous as-of date through this as-of date):

| Step | Formula / rule |
| --- | --- |
| Est. staking rewards | `ETH staked (previous report) × stated 7-day BMNR yield (this report) × days / 365` |
| Est. ETH bought | `ETH held_t − ETH held_{t−1} − rewards` (the 10-Q's digital-asset roll-forward shows staking rewards are added to ETH units) |
| ETH purchase cost | `ETH bought × average daily ETH price in the window` (CoinGecko), or disclosed cost |
| Buyback cost | `shares × disclosed avg price`; if not disclosed, `shares × window avg BMNR close × k`, where k is calibrated so all buybacks sum to Bitmine's disclosed total ($399.6M / 22.9M shares in 2026; k ≈ 1.005) |
| Est. cash costs | `$3,257,538/week` opex = (G&A $37.270M − share-based comp $0.648M + cost of sales $5.726M) ÷ 13 from the 10-Q, **plus** `$646,450/week` BMNP dividends (3.5M shares × $0.1847); prorated by days |
| Implied equity raise | `Δcash + ETH cost + buyback cost + cash costs − disclosed proceeds` |
| Est. shares issued | `max(0, raise) ÷ window average BMNR close` (or the disclosed number) |
| Shares outstanding | `previous + issued + RSU/other disclosed issuance − buyback shares`; replaced by any official count |
| Range | low: cash costs = 0 and issue at the window's highest close; high: 2× cash costs and issue at the window's lowest close |

The week containing July 9 only adds issuance for trading days after July 9 (1 of 5). Selling staking ETH for cash
does not distort the identity (it lowers estimated purchases and raises cash by the same amount).
Known limitations: actual purchase/sale prices, marketable-securities price changes, Eightco/other investment cash flows,
and one-off costs are unknown. Negative implied raises are treated as zero issuance.

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
   When an official share count appears (e.g. the FY-Aug-2026 10-K), add `--shares-outstanding` on that week (or set
   `shares_outstanding_official` on the matching release) and consider moving `anchor` to it.
4. Check the printed table, then `git add data && git commit -m "week of <date>" && git push`. Pages redeploys in ~1 min.

## Notes / caveats

* **Shares outstanding** after July 9, 2026 is an estimate with a range (see above). The fiscal year-end changes from Aug 31 to Dec 31 after FY2026; expect a 10-K (FY ended Aug 31, 2026) and later a 10-KT.

* **ORBS** = Eightco Holdings (NASDAQ: ORBS) **stock** — not the "Orbs" crypto token on CoinGecko. 100,655,143 shares per
  Bitmine's 10-Q; weekly snapshots use the reported $ value, the live page uses shares × live price.
* Beast Industries is carried at the disclosed $180M. BMNP preferred and other liabilities are not deducted.
* GitHub cron schedules can run late or be skipped under load; the page always shows each price's timestamp.

Not investment advice.

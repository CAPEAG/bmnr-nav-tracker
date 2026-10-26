# BMNR NAV / mNAV Tracker

Live site: **https://capeag.github.io/bmnr-nav-tracker/**

A static dashboard (plain HTML/CSS/JS + Chart.js from a CDN, no build step) that tracks the NAV, NAV per share and
mNAV of **Bitmine Immersion Technologies (NYSE: BMNR)** using:

* **Live ETH & BTC prices**, fetched in the browser from the free CoinGecko API on load and every 60 s
  (falls back to the last saved prices in `data/prices.json`, then to the last announcement's prices).
* **BMNR, ETHA and ORBS quotes**, saved to `data/prices.json` by a GitHub Action every ~15 min during US market
  hours (Yahoo Finance chart endpoint, keyless; Stooq CSV as fallback). The page re-reads that file every 5 min.
* **Weekly holdings** from Bitmine's Monday-morning holdings announcement, stored in `data/holdings.json`, with a
  snapshot appended to `data/history.json` each week.

The formulas replicate the shared Google Sheet's `BMNR` tab cell-for-cell (see `assets/calc.js`; verified to
reproduce the sheet's Full NAV $14,920,334,556, NAV/share $23.71, mNAV 0.922, EV mNAV 1.051 and SOTP $25.92 / $26.52 / $26.70
from the sheet's own inputs).

## Files

| Path | What it is |
| --- | --- |
| `index.html`, `assets/style.css`, `assets/app.js` | The page. |
| `assets/calc.js` | All NAV / mNAV / valuation formulas (shared by the page and the weekly script). |
| `data/holdings.json` | Current balance sheet + assumptions (ETH, staked ETH, BTC, cash, ORBS stake, Beast stake, shares outstanding, staking yield, valuation inputs, source links, last update). |
| `data/history.json` | One snapshot per weekly announcement (ETH, ETH added, est. staking ETH, assumed purchase price, buyback shares/price, cash, est. shares issued/outstanding, NAV/share and mNAV at the snapshot, source URLs, notes). |
| `data/prices.json` | Latest BMNR / ETHA / ORBS (+ ETH, BTC) quotes with timestamps. Written by the Action. |
| `scripts/fetch-prices.mjs` | Price fetcher used by the Action (`node scripts/fetch-prices.mjs`). |
| `scripts/add-week.mjs` | Weekly update helper: applies the assumptions below and updates both data files. |
| `.github/workflows/prices.yml` | Cron (every 15 min 13:00–21:59 UTC Mon–Fri, hourly pre/after-hours) + manual `workflow_dispatch`. Commits only when prices changed. |

## Formulas (from the sheet)

* Full NAV = BTC×BTCUSD + ETH×ETHUSD + cash + ORBS shares×ORBS price + Beast stake
* Crypto/Cash NAV = BTC + ETH + cash; ETHUSD NAV = ETH only
* Enterprise Value = market cap − cash (the sheet's EV-row "mNAV" = market cap ÷ EV)
* NAV/share = NAV ÷ shares outstanding; mNAV = BMNR price ÷ NAV/share
* ETH/share = ETH ÷ shares; ETHA ratio = BMNR ÷ ETHA; "BMNR target" = ETHA × 1.4
* Staking scenario: ETH generated = yield × ETH staked (bear = currently staked ETH, base = all ETH, bull = 6,105,000);
  USD = × ETH price; SG&A bear = 1.5% × USD + $50M, base $55M, bull $60M; equity = (USD − SG&A) × 5; ÷ shares
* MAVAN: rewards = AUM ($2B) × 4.5%; profit = rewards × 9.85% / 12.5% / 15%; equity = profit × 15 / 20 / 25; ÷ shares
* SOTP/share = staking equity/share + Full NAV/share + MAVAN equity/share; implied mNAV = SOTP ÷ Full NAV/share

## Weekly assumptions

Bitmine does not disclose staking rewards, its average purchase price or (usually) ATM share issuance, so:

| Item | Rule |
| --- | --- |
| Est. staking rewards (ETH) | `ETH staked at start of week × weekly_staking_yield × 7 / 365` (yield default 2.58% = Bitmine's disclosed 7-day BMNR yield) |
| Est. ETH purchased | `reported ETH holdings change − est. staking rewards` (assumes rewards are included in reported holdings) |
| Purchase price | Disclosed if given, else **average daily ETH price over the week** (Mon–Sun ending on the "as of" date, CoinGecko) |
| Buyback price | Disclosed if given, else **average BMNR close over that week's trading days** (Yahoo) |
| Implied equity raise | `ETH purchase cost + buyback cost − decrease in cash` (same as sheet cells L7–L12) |
| Est. ATM shares issued | If raise > 0: `raise ÷ average BMNR close that week`, else 0 |
| Shares outstanding | `previous + est. issued − buyback shares`, unless an official count is supplied |

## Weekly update procedure (Mondays, after Bitmine posts)

1. Open the announcement: **X: [@BitMNR](https://x.com/BitMNR)** thread "BitMine provided its latest holdings update for …"
   (usually ~8:30 AM ET Monday) which links the **PR Newswire** release
   (`prnewswire.com/news-releases/bitmine-immersion-technologies-bmnr-announces-eth-holdings-reach-…`). The same release is
   filed as an 8-K (Ex. 99.1) on [SEC EDGAR, CIK 1829311](https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001829311&type=8-K).
2. Read off: as-of date, total ETH, ETH price used, BTC, Beast stake, Eightco (ORBS) stake $ value,
   total cash & marketable securities, total staked ETH, and any buyback (shares + average price) or disclosed share count.
3. Run (Node 20+, from the repo root):

   ```bash
   node scripts/add-week.mjs --date 2026-11-02 --asof 2026-11-01 \
     --eth <total ETH> --staked <staked ETH> --btc <BTC> --cash <cash USD> \
     --orbs-value <Eightco stake USD> --beast 180000000 --pr-eth-price <ETH price in release> \
     [--buyback-shares <n> --buyback-price <avg>] [--purchase-price <if disclosed>] \
     [--shares-outstanding <if officially disclosed>] [--shares-issued <if disclosed>] \
     --source "<press release URL>" --x "<@BitMNR post URL>" --notes "<anything unusual>"
   ```

   Add `--dry` first to preview. The script fetches the week's ETH/BTC (CoinGecko) and BMNR/ORBS (Yahoo) daily prices,
   computes the estimates above, updates `data/holdings.json` (balance sheet, `last_week`, `reference_prices`) and appends to
   `data/history.json`.
4. Sanity-check the printed snapshot (ETH added should match "we acquired N ETH"), then
   `git add data && git commit -m "week of <date>" && git push`. GitHub Pages redeploys in ~1 min.
   Also pass `--staking-yield <stated 7-day BMNR yield, e.g. 0.0258>` and `--sec <8-K Ex. 99.1 URL>`.
5. Occasionally refresh `shares_outstanding` with an official count (10-Q/10-K cover page or an 8-K) via
   `--shares-outstanding`, and review `assumptions` in `data/holdings.json` (staking yield, valuation scenario inputs).

Manual editing is fine too: every field in `data/holdings.json` / `data/history.json` is plain JSON.

## Notes / caveats

* **Shares outstanding**: last official count is 603,226,394 as of July 9, 2026 (10-Q cover). Everything after that is an estimate (see `shares_audit_note` in `data/holdings.json`). Replace it with `--shares-outstanding` when the FY2026 10-K (fiscal year ends Aug 31) or the next 10-Q is filed.

* **ORBS** = Eightco Holdings (NASDAQ: ORBS) **stock** — not the "Orbs" crypto token on CoinGecko. The 100,000,000 share
  count is the sheet's assumption (Bitmine only reports the $ value; $76M ÷ 100M ≈ the ORBS share price, so it is consistent).
* Beast Industries is carried at the disclosed $180M. BMNP preferred and other liabilities are not deducted (as in the sheet).
* The sheet's 30/60-day ETHA-ratio Z-scores come from a different spreadsheet via IMPORTRANGE; they are shown as a static copy.
* GitHub cron schedules can run late or be skipped under load; the page always shows each price's timestamp.

Not investment advice.

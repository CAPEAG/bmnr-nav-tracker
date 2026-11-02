#!/usr/bin/env node
// Independent ETH staking-yield series from Lido's on-chain oracle reports (stETH TokenRebased events), written to
// data/staking_yield.json. One report per day (~12:00 UTC). For each report:
//   net APR   = (post share rate ÷ pre share rate − 1) × 365 days ÷ timeElapsed   (Lido's documented stETH APR formula,
//               = what eth-api.lido.fi/v1/protocol/steth/apr reports; net of Lido's fee)
//   gross APR = the same with the fee shares minted in that report added back
//               (post share rate = postTotalEther ÷ (postTotalShares − sharesMintedAsFees)), i.e. the validators'
//               consensus + execution-layer rewards before Lido's fee — the figure comparable to Bitmine's own yield.
// The model (scripts/model.mjs → weekStakingYield) uses the time-weighted average gross APR over each release window.
// Keyless public RPCs (archive eth_getLogs): rpc.mevblocker.io, Tenderly public gateway, Flashbots (recent only).
// Incremental: re-fetches from the last stored block. Usage: node scripts/fetch-staking-yield.mjs [--from-block N] [--full]
import { readFile, writeFile } from 'node:fs/promises';

const OUT = new URL('../data/staking_yield.json', import.meta.url);
const STETH = '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84';
// keccak256("TokenRebased(uint256,uint256,uint256,uint256,uint256,uint256,uint256)")
const TOPIC = '0xff08c3ef606d198e316ef5b822193c489965899eb4e3c248cea1a4626c3eda50';
const RPCS = ['https://rpc.mevblocker.io', 'https://gateway.tenderly.co/public/mainnet', 'https://rpc.flashbots.net'];
const FIRST_BLOCK = 23780000; // ≈ Nov 12, 2025 (two weeks before the first release window)
const CHUNK = 9000;
const YEAR = 365 * 86400;

async function rpc(method, params) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) for (const url of RPCS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30000) });
      const j = await r.json();
      if (j.error) throw new Error(`${url}: ${j.error.message}`);
      return j.result;
    } catch (e) { last = e; }
  }
  throw last;
}
const hex = (n) => '0x' + n.toString(16);
const word = (data, k) => BigInt('0x' + data.slice(2 + 64 * k, 2 + 64 * (k + 1)));
const E27 = 10n ** 27n;
const ratio = (a, b) => Number((a * E27) / b) / 1e27;

const old = JSON.parse(await readFile(OUT, 'utf8').catch(() => 'null'));
const fromArg = process.argv.indexOf('--from-block');
const full = process.argv.includes('--full') || !old;
let from = fromArg > 0 ? Number(process.argv[fromArg + 1]) : full ? FIRST_BLOCK : old.last_block + 1;
const head = parseInt(await rpc('eth_blockNumber', []), 16);
const reports = full ? [] : old.reports.slice();
const seen = new Set(reports.map((x) => x.tx));
for (let b = from; b <= head; b += CHUNK) {
  const to = Math.min(head, b + CHUNK - 1);
  const logs = await rpc('eth_getLogs', [{ address: STETH, topics: [TOPIC], fromBlock: hex(b), toBlock: hex(to) }]);
  for (const l of logs) {
    if (seen.has(l.transactionHash)) continue;
    const reportTs = Number(BigInt(l.topics[1]));
    const [elapsed, preS, preE, postS, postE, fees] = [0, 1, 2, 3, 4, 5].map((k) => word(l.data, k));
    const t = Number(elapsed);
    const pre = ratio(preE, preS), postNet = ratio(postE, postS), postGross = ratio(postE, postS - fees);
    const net = (postNet / pre - 1) * YEAR / t, gross = (postGross / pre - 1) * YEAR / t;
    reports.push({
      date: new Date(reportTs * 1000).toISOString().slice(0, 10), report_time_utc: new Date(reportTs * 1000).toISOString(),
      block: parseInt(l.blockNumber, 16), tx: l.transactionHash, time_elapsed_s: t,
      apr_net: +net.toFixed(6), apr_gross: +gross.toFixed(6), fee_share: +(1 - net / gross).toFixed(4),
    });
    seen.add(l.transactionHash);
  }
  if (((b - from) / CHUNK) % 25 === 0 || to === head) console.log(`blocks ${b}–${to}: ${reports.length} reports`);
}
reports.sort((a, b) => a.block - b.block);
const out = {
  description: 'Daily Lido oracle reports (stETH TokenRebased events) since Nov 2025: the independent ETH staking yield used by the share model. apr_gross (before Lido\'s fee, the fee shares minted in each report added back) is the model input; apr_net = Lido\'s published stETH APR. Each release week uses the time-weighted average apr_gross of the reports dated inside its window (previous as-of + 1 day … as-of).',
  source: {
    contract: `stETH ${STETH} (Ethereum mainnet), event TokenRebased(reportTimestamp, timeElapsed, preTotalShares, preTotalEther, postTotalShares, postTotalEther, sharesMintedAsFees)`,
    formula_net: 'apr_net = (postTotalEther/postTotalShares ÷ preTotalEther/preTotalShares − 1) × 31,536,000 ÷ timeElapsed (Lido docs: "APR for stETH")',
    formula_gross: 'apr_gross = (postTotalEther/(postTotalShares − sharesMintedAsFees) ÷ preTotalEther/preTotalShares − 1) × 31,536,000 ÷ timeElapsed',
    rpc: RPCS, cross_check: 'https://eth-api.lido.fi/v1/protocol/steth/apr/sma (last 7 daily net APRs)',
    script: 'node scripts/fetch-staking-yield.mjs',
  },
  fetched: new Date().toISOString(), last_block: head, reports,
};
await writeFile(OUT, JSON.stringify(out, null, 1) + '\n');
console.log(`wrote ${reports.length} reports (${reports[0]?.date} … ${reports.at(-1)?.date}) to data/staking_yield.json`);
// cross-check the latest net APRs with Lido's API
try {
  const j = await (await fetch('https://eth-api.lido.fi/v1/protocol/steth/apr/sma')).json();
  for (const a of j.data.aprs) {
    const m = reports.find((x) => Math.abs(new Date(x.report_time_utc) / 1000 - a.timeUnix) < 6 * 3600) || reports.filter((x) => x.date === new Date(a.timeUnix * 1000).toISOString().slice(0, 10)).at(-1);
    console.log('lido api', new Date(a.timeUnix * 1000).toISOString().slice(0, 16), a.apr.toFixed(3) + '%', '| on-chain net', m ? (m.apr_net * 100).toFixed(3) + '%' : 'n/a', 'gross', m ? (m.apr_gross * 100).toFixed(3) + '%' : '');
  }
} catch (e) { console.warn('Lido API cross-check skipped:', e.message); }

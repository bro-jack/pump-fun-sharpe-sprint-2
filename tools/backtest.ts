// Backtest for the Sharpe Sprint entry: runs strategy.ts over 6-hour
// slices of the kit's 24h dataset and prints the per-slice table the
// house would score (hourly Sharpe, net PnL, round trips, drawdown).
// Usage:
//   node tools/backtest.ts <kit-dir> [--params '{"buyersLow":3,"takeProfitBps":2500}'] [--offsets 0,6,12,18]
// No network, no randomness: two runs print byte-identical numbers.
import { readFileSync } from 'node:fs';
import { createBot, SCALP_CONFIG, type ScalpConfig } from '../strategy.ts';
import { loadSlices, scoreSlice } from './harness.ts';

const kit = process.argv[2]!;
const rest = process.argv.slice(3);
const paramsFlag = rest.find((a) => a.startsWith('--params='));
const offsetsFlag = rest.find((a) => a.startsWith('--offsets='));
const hoursFlag = rest.find((a) => a.startsWith('--hours='));
const cfg: ScalpConfig = paramsFlag ? { ...SCALP_CONFIG, ...JSON.parse(paramsFlag.slice(9)) } : SCALP_CONFIG;
const offsets = offsetsFlag ? offsetsFlag.slice(10).split(',').map(Number) : [0, 3, 6, 9, 12, 15, 18];
const hours = hoursFlag ? Number(hoursFlag.slice(8)) : 6;

const kitJson = JSON.parse(readFileSync(`${kit}/kit.json`, 'utf8'));
const slices = loadSlices(kit, offsets, hours);
console.log(`config: ${JSON.stringify(cfg)}`);
console.log(`slices: ${slices.map((s) => s.name).join(' ')}  (${hours}h each, from ${new Date(slices[0]!.opensAt * 1000).toISOString()})`);
console.log('slice   netSOL  sharpe  trips wins coins qualMin  dd      fills rej fail  best    worst   hourlyPnL(SOL)');
let worstSharpe = Infinity;
let minQual = Infinity;
let allPositive = true;
for (const s of slices) {
  const r = await scoreSlice(kit, s, createBot(cfg), kitJson.dataset_sha256);
  if (r.sharpe !== null && r.sharpe < worstSharpe) worstSharpe = r.sharpe;
  if (r.coinsQualifying < minQual) minQual = r.coinsQualifying;
  if (r.pnlSol <= 0) allPositive = false;
  const sh = r.sharpe === null ? '  null' : r.sharpe.toFixed(2).padStart(6);
  console.log(
    `${r.name.padEnd(6)} ${r.pnlSol.toFixed(3).padStart(7)} ${sh} ${String(r.roundTrips).padStart(5)} ${String(r.winningTrips).padStart(4)} ${String(r.coinsTraded).padStart(5)} ${String(r.coinsQualifying).padStart(7)} ${r.maxDrawdown.toFixed(4).padStart(7)} ${String(r.fillCount).padStart(6)} ${String(r.rejectCount).padStart(3)} ${String(r.failCount).padStart(4)} ${r.bestTripSol.toFixed(3).padStart(7)} ${r.worstTripSol.toFixed(3).padStart(7)}  [${r.hourlyPnlSol.map((x) => x.toFixed(3)).join(' ')}]`,
  );
}
console.log(`aggregate: worst sharpe ${worstSharpe === Infinity ? 'null' : worstSharpe.toFixed(2)}, min qualifying mints ${minQual}, all slices PnL>0: ${allPositive}`);

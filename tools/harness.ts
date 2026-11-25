// Shared scoring rig for the Sharpe Sprint entry: cuts the kit's 24h
// dataset into 6-hour windows and scores a bot on each one the way the
// house scorer does (sim/metrics.ts):
//   - hourly equity marks from the window's first block time, carried
//     forward through empty hours, final mark after the last flatten
//   - r_i = (m_i - m_{i-1}) / m_{i-1}; sharpe = mean(r) / sample-std(r)
// Equity is sampled by wrapping the bot: after every batch the wrapper
// reads state.cash plus positions marked at that batch's reserves — the
// same instant the house marks equity. Positions live for seconds, so the
// mark-to-market at hour boundaries is small, but it is counted, not
// ignored.
//
// The grader seeds its failed-tx draw from the kit's seed key
// (kit.json bundle_sha256) AND the frozen dataset's own digest
// (dataset/manifest.json dataset_sha256) — not kit.json's dataset_sha256
// and not the competition slug. Get either value wrong and the failed-tx
// draws (and the trip counts) silently shift.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

export const OPENING_CASH = 10_000_000_000n;
const FEE_BPS = 125n;
const BPS_NUM = 10_000n;

export interface Slice {
  name: string;
  opensAt: number;
  rows: any[];
  groups: { slot: number; events: any[] }[];
  lastSlot: number;
}

export interface SliceScore {
  name: string;
  pnlSol: number;
  sharpe: number | null;
  hourlyPnlSol: number[];
  hourlyReturns: number[];
  roundTrips: number;
  winningTrips: number;
  coinsTraded: number;
  coinsQualifying: number;
  maxDrawdown: number;
  fillCount: number;
  rejectCount: number;
  failCount: number;
  bestTripSol: number;
  worstTripSol: number;
}

/** SOL back for selling `tokens` against (vq, vt), after curve fees. */
function exitValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const gross = (tokens * vq) / (vt + tokens);
  return gross - (gross * FEE_BPS + BPS_NUM - 1n) / BPS_NUM;
}

/** Sharpe from a list of periodic returns; null when undefined. */
export function sharpeOf(returns: number[]): number | null {
  if (returns.length < 2) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  let sq = 0;
  for (const r of returns) sq += (r - mean) * (r - mean);
  const sd = Math.sqrt(sq / (returns.length - 1));
  if (sd === 0) return null;
  return mean / sd;
}

export function loadSlices(kitDir: string, offsetsHours: number[], hours = 6): Slice[] {
  const manifest = JSON.parse(readFileSync(`${kitDir}/dataset/manifest.json`, 'utf8'));
  const { modulus, residue } = manifest.universe.sample;
  const excluded = new Set<string>(manifest.excluded_mints ?? []);
  const rows: any[] = [];
  for (let part = 0; part < 3; part++) {
    const text = gunzipSync(readFileSync(`${kitDir}/dataset/events/part-0000${part}.ndjson.gz`)).toString('utf8');
    const parsed = text.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l));
    const live = new Set<string>();
    for (const e of parsed) {
      if (e.event === 'CreateEvent' && !live.has(e.mint)) {
        const digest = BigInt('0x' + createHash('sha256').update(e.mint, 'utf8').digest('hex'));
        const inSample =
          e.quote_mint === '11111111111111111111111111111111' &&
          !e.is_mayhem_mode &&
          !e.is_cashback_enabled &&
          !excluded.has(e.mint) &&
          digest % BigInt(modulus) === BigInt(residue);
        if (inSample) live.add(e.mint);
      }
      if (live.has(e.mint)) rows.push(e);
    }
  }
  // block_time is null on some rows: carry the last seen value forward.
  // Rows arrive in slot order.
  let seen = 0;
  for (const e of rows) {
    if (typeof e.block_time === 'number') seen = e.block_time;
    e._t = seen;
  }
  const t0 = rows[0]._t;
  // A coin belongs to a slice only if it was CREATED inside it: in the
  // real final window a coin created earlier does not exist at all, so its
  // later trades must not leak in.
  const bornAt = new Map<string, number>();
  for (const e of rows) {
    if (e.event === 'CreateEvent' && !bornAt.has(e.mint)) bornAt.set(e.mint, e._t);
  }
  const slices: Slice[] = [];
  for (const off of offsetsHours) {
    const start = t0 + off * 3600;
    const end = start + hours * 3600;
    const kept = rows.filter((e) => {
      const born = bornAt.get(e.mint);
      return born !== undefined && born >= start && born < end && e._t >= start && e._t < end;
    });
    if (kept.length === 0) continue;
    const groups: { slot: number; events: any[] }[] = [];
    for (const e of kept) {
      const tail = groups[groups.length - 1];
      if (tail !== undefined && tail.slot === e.slot) tail.events.push(e);
      else groups.push({ slot: e.slot, events: [e] });
    }
    slices.push({ name: `+${off}h`, opensAt: start, rows: kept, groups, lastSlot: kept[kept.length - 1].slot });
  }
  return slices;
}

export async function scoreSlice(kitDir: string, slice: Slice, bot: any, datasetSha: string): Promise<SliceScore> {
  const sim: any = await import(`${kitDir}/baselines/pilot/momentum/tools/sim.ts`);
  const kitJson = JSON.parse(readFileSync(`${kitDir}/kit.json`, 'utf8'));
  const manifest = JSON.parse(readFileSync(`${kitDir}/dataset/manifest.json`, 'utf8'));
  const seedKey = kitJson.bundle_sha256 ?? kitJson.competition;
  const hello = sim.makeHello(sim.phaseSeed(seedKey, 'dev', manifest.dataset_sha256));
  const ds = { sha256: datasetSha, events: slice.rows, endSlot: slice.lastSlot, batches: slice.groups };

  // Wrap the bot: sample (block_time, equity) after every batch, and note
  // the filled buy size per mint (for the >= 0.01 SOL round-trip bar).
  const samples: { t: number; equity: bigint }[] = [];
  const bought = new Map<string, bigint>();
  let clock = slice.opensAt;
  const wrapped = {
    onBatch(state: any, batch: any) {
      let t = clock;
      for (const ev of batch.events) {
        if (typeof ev.block_time === 'number' && ev.block_time > t) t = ev.block_time;
      }
      clock = t;
      for (const f of batch.fills) {
        if (f.side === 'buy' && f.status === 'filled') {
          bought.set(f.mint, (bought.get(f.mint) ?? 0n) + BigInt(f.quote_lamports));
        }
      }
      const tx = state.txFeeLamports();
      let equity = state.cash;
      for (const [mint, pos] of state.positions) {
        const mk = batch.marks.find((m: any) => m.mint === mint);
        let vq: bigint;
        let vt: bigint;
        if (mk !== undefined) {
          vq = BigInt(mk.virtual_quote_reserves);
          vt = BigInt(mk.virtual_token_reserves);
        } else {
          const curve = state.curves.get(mint);
          if (curve === undefined) continue;
          vq = curve.virtual_quote_reserves;
          vt = curve.virtual_token_reserves;
        }
        const net = exitValue(pos.token_amount, vq, vt) - tx;
        if (net > 0n) equity += net;
      }
      samples.push({ t, equity });
      return bot.onBatch(state, batch);
    },
  };
  const simResult = sim.simulate(ds, hello, wrapped);

  // Hourly marks, house rule: marks[0] = start; carry forward through
  // empty hours; last mark = final cash after the flatten.
  const t0 = slice.opensAt;
  const finalCash = OPENING_CASH + simResult.netPnl;
  const marks: bigint[] = [OPENING_CASH];
  let bucket = 0;
  let current = OPENING_CASH;
  for (const p of samples) {
    const k = Math.max(bucket, Math.floor((p.t - t0) / 3600));
    while (bucket < k) {
      marks.push(current);
      bucket++;
    }
    current = p.equity;
  }
  marks.push(finalCash);
  const hourlyPnlSol = marks.slice(1).map((m, i) => Number(m - marks[i]!) / 1e9);
  const hourlyReturns = marks.slice(1).map((m, i) => (Number(m) - Number(marks[i]!)) / Number(marks[i]!));
  const closed = new Set(simResult.trips.map((t: any) => t.mint));
  let qualifying = 0;
  for (const [mint, amount] of bought) {
    if (closed.has(mint) && amount >= 10_000_000n) qualifying++;
  }
  const tripPnls = simResult.trips.map((t: any) => Number(t.pnl) / 1e9);
  return {
    name: slice.name,
    pnlSol: Number(simResult.netPnl) / 1e9,
    sharpe: sharpeOf(hourlyReturns),
    hourlyPnlSol,
    hourlyReturns,
    roundTrips: simResult.trips.length,
    winningTrips: simResult.trips.filter((t: any) => t.pnl > 0n).length,
    coinsTraded: simResult.mints,
    coinsQualifying: qualifying,
    maxDrawdown: simResult.maxDrawdown,
    fillCount: simResult.fills,
    rejectCount: simResult.rejected,
    failCount: simResult.failed,
    bestTripSol: tripPnls.length ? Math.max(...tripPnls) : 0,
    worstTripSol: tripPnls.length ? Math.min(...tripPnls) : 0,
  };
}

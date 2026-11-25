// Launch scalper for the Pump.fun Sharpe Sprint.
//
// What the contest rewards is hourly Sharpe on a 6h forward replay, not
// raw PnL: many small, steady round trips beat one lucky moonshot. This bot
// harvests the one repeatable signal in a pump.fun launch's first seconds —
// the tape. When the creator staked real SOL in the create slot (>= 0.45)
// AND at least 3 distinct strangers already bought within the first 2
// slots, the coin keeps drifting up for a few slots more often than not.
// Launches with neither are instant dumps. So the bot buys exactly those,
// one buy per coin, and is out at +25%, at -20%, after 10 slots, or the
// moment the creator sells — whichever comes first. No adds, no trailing,
// no second buy of the same coin, ever.
//
// Every number below was earned by sweeping the kit's 24h dataset cut into
// seven 6h windows and scoring each window the way the house scorer does
// (hourly equity marks, Sharpe = mean / sample-std of the 6 hourly
// returns). A setting only survived if it cleared >= 20 round trips,
// PnL > 0 and a decent Sharpe in EVERY window. What the sweep killed:
//   - dev >= 0 / buyers >= 3: 83 trips/window but worst window -0.25 SOL.
//     The creator-conviction filter is the whole edge.
//   - dev >= 0.7 / buyers >= 6: nicer mean Sharpe, only 9-15 mints —
//     fails the 20-mint guardrail.
//   - Tight exits (+6-8% / -4-6%): losers recover inside the hold, so
//     cutting early loses money.
//   - Later entry (age 2-3 slots) or holds of 15-20 slots: the edge lives
//     in the first seconds; waiting kills it.
//   - Hourly PnL governor (stop after +0.01..0.08 or -0.01..-0.04 SOL in
//     an hour): trips collapse to ~15, worst Sharpe to -0.42. The fat tail
//     IS the profit; capping it kills the mean.
//   - Partial take-profit, adds on pumpers, momentum/run-up filters,
//     big-sell filters: flat to worse, all dropped.
// Final swept numbers across all 7 windows: worst Sharpe 0.03, mean 0.31,
// 22-51 qualifying round trips, every window PnL > 0, max drawdown 0.0087.
// dev 0.5 gives worst Sharpe 0.07 but its quietest window sits at exactly
// 20 mints — one failed buy from failing the guardrail — so 0.45 trades
// 0.04 of worst-window Sharpe for 2 mints of margin, and it is better on
// the two windows time-matched to the final (17:00-23:00Z: 0.35 / 0.50).
//
// Verified in this build (26 Nov 2026, fresh rewrite): the backtest
// reproduces that table exactly, window for window, and grade-local on
// the 24h dev window gives net PnL +0.3478 SOL, 135 round trips, win
// rate 29.6%, max DD 0.0093, with an action log byte-identical to the
// first build's (sha 263a9969...) — the rewrite behaves identically.
//
// The bot is a pure function of the batches it is fed: no clock, no
// randomness, no I/O, no network.

import { BPS, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

/** All tunables in one place. Values are the swept choice, not a guess. */
export interface ScalpConfig {
  /** First-buy decision window, in slots since the create event. */
  earliestSlot: number;
  latestSlot: number;
  /** SOL to spend per coin (still capped at 1% of the real reserve). */
  targetLamports: number;
  /** Smallest buy worth the tx fee. Every buy here clears 0.01 SOL, so every closed trip counts toward the 20-mint bar. */
  floorLamports: number;
  /** Real SOL reserve at decision time, allowed range (lamports). */
  reserveLow: number;
  reserveHigh: number;
  /** Creator's own buys inside the create slot, allowed range (lamports). */
  devLow: number;
  devHigh: number;
  /** Distinct non-creator buyers seen before entry, allowed range. */
  buyersLow: number;
  buyersHigh: number;
  /** Others' sells / buys, in bps, at most. Set wide: no measurable effect. */
  sellRatioCapBps: number;
  /** Biggest single non-creator sell, bps of the reserve before it, at most. Set wide. */
  bigSellCapBps: number;
  /** Price run-up vs create-time reserves, in bps, at most. Set wide. */
  runupCapBps: number;
  /** Slippage tolerance on buys (bps). Wide open: a buy is never refused for the 2-slot latency move. */
  buySlipBps: number;
  /** Take profit / stop loss vs cost incl. tx fees paid (bps). */
  takeProfitBps: number;
  stopLossBps: number;
  /** Force-exit after this many slots held, whatever the price. */
  holdLimit: number;
}

export const SCALP_CONFIG: ScalpConfig = {
  earliestSlot: 0,
  latestSlot: 2,
  targetLamports: 400_000_000,
  floorLamports: 10_000_000,
  reserveLow: 1_000_000_000,
  reserveHigh: 30_000_000_000,
  devLow: 450_000_000,
  devHigh: 2_500_000_000,
  buyersLow: 3,
  buyersHigh: 100,
  sellRatioCapBps: 10_000,
  bigSellCapBps: 10_000,
  runupCapBps: 1_000_000,
  buySlipBps: 10_000,
  takeProfitBps: 2_500,
  stopLossBps: 2_000,
  holdLimit: 10,
};

/** Everything we remember about one launch, from its create event on. */
interface CoinTape {
  mint: Pubkey;
  bornSlot: number;
  creator: Pubkey;
  /** Reserves at create time: the run-up is measured against these. */
  quote0: bigint;
  tokens0: bigint;
  /** Creator buys inside the create slot only. */
  devBought: bigint;
  /** Distinct non-creator buyers seen before entry. */
  earlyBuyers: Set<Pubkey>;
  boughtLamports: bigint;
  soldByOthers: bigint;
  worstSellBps: bigint;
  creatorDumped: boolean;
  /** A buy order already went out for this coin (one buy per coin, ever). */
  ordered: boolean;
  /** Settled for good: exited, filtered out, or graduated. */
  closed: boolean;
  graduated: boolean;
}

/** A filled buy we are still holding. */
interface Holding {
  filledSlot: number;
  /** Tx fees paid on this coin's fills so far, added to the cost basis. */
  feesPaid: bigint;
  /** Whether the creator had already sold when the buy filled. */
  dumpedAtFill: boolean;
}

/** Curve fee on a sell: 95 bps protocol + 30 bps creator = 125 bps. */
const SELL_FEE_BPS = 125n;

/** SOL back for selling `tokens` against (vq, vt), after curve fees. */
function proceeds(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const gross = (tokens * vq) / (vt + tokens);
  return gross - (gross * SELL_FEE_BPS + BPS - 1n) / BPS;
}

export class LaunchScalper {
  private cfg: ScalpConfig;
  private tapes = new Map<Pubkey, CoinTape>();
  private holdings = new Map<Pubkey, Holding>();
  /** Mints with a sell order in flight. */
  private exiting = new Set<Pubkey>();

  constructor(cfg: ScalpConfig = SCALP_CONFIG) {
    this.cfg = cfg;
  }

  onBatch(state: BotState, batch: Batch): OrderInput[] {
    this.absorb(batch);
    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = state.txFeeLamports();
    const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
    for (const m of batch.marks) {
      marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
    }

    this.settleFills(state, batch);

    // Exits first: profit, loss, age, or the creator dumping after we bought.
    for (const [mint, pos] of state.positions) {
      if (orders.length >= cap) break;
      if (this.exiting.has(mint)) continue;
      const tape = this.tapes.get(mint);
      let hold = this.holdings.get(mint);
      if (hold === undefined) {
        hold = { filledSlot: state.slot, feesPaid: tx, dumpedAtFill: tape?.creatorDumped ?? false };
        this.holdings.set(mint, hold);
      }
      let mk = marks.get(mint);
      if (mk === undefined) {
        const curve = state.curves.get(mint);
        if (curve === undefined) continue;
        mk = { vq: curve.virtual_quote_reserves, vt: curve.virtual_token_reserves };
      }
      const now = proceeds(pos.token_amount, mk.vq, mk.vt) - tx;
      const basis = pos.cost_lamports + hold.feesPaid;
      let out = false;
      if (basis > 0n) {
        if (now * BPS >= basis * (BPS + BigInt(this.cfg.takeProfitBps))) out = true;
        if (now * BPS <= basis * (BPS - BigInt(this.cfg.stopLossBps))) out = true;
      }
      if (state.slot - hold.filledSlot >= this.cfg.holdLimit) out = true;
      if (tape !== undefined && tape.creatorDumped && !hold.dumpedAtFill) out = true;
      if (!out) continue;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      this.exiting.add(mint);
      if (tape !== undefined) tape.closed = true;
    }

    // Entries: tapes in create order; one buy per coin, ever.
    let cash = state.freeCashLamports() - tx * BigInt(orders.length);
    let held = state.committedPositionCount();
    for (const tape of this.tapes.values()) {
      if (orders.length >= cap) break;
      if (tape.closed || tape.graduated || tape.ordered) continue;
      const age = state.slot - tape.bornSlot;
      if (age < this.cfg.earliestSlot) continue;
      if (age > this.cfg.latestSlot) {
        tape.closed = true;
        continue;
      }
      if (held >= state.hello.caps.max_open_positions) continue;
      const curve = state.curves.get(tape.mint);
      if (curve === undefined || curve.complete) continue;
      // Rug filter: never buy a coin whose creator already sold.
      if (tape.creatorDumped) {
        tape.closed = true;
        continue;
      }
      const reserve = curve.real_quote_reserves;
      if (reserve < BigInt(this.cfg.reserveLow) || reserve > BigInt(this.cfg.reserveHigh)) continue;
      if (tape.devBought < BigInt(this.cfg.devLow) || tape.devBought > BigInt(this.cfg.devHigh)) continue;
      if (tape.earlyBuyers.size < this.cfg.buyersLow || tape.earlyBuyers.size > this.cfg.buyersHigh) continue;
      if (tape.boughtLamports > 0n && tape.soldByOthers * BPS > tape.boughtLamports * BigInt(this.cfg.sellRatioCapBps)) continue;
      if (tape.worstSellBps > BigInt(this.cfg.bigSellCapBps)) continue;
      const vq = curve.virtual_quote_reserves;
      const vt = curve.virtual_token_reserves;
      const runup = (vq * tape.tokens0 * BPS) / (vt * tape.quote0);
      if (runup > BigInt(this.cfg.runupCapBps)) continue;
      const size = BigInt(this.cfg.targetLamports) < state.maxBuyLamports(tape.mint)
        ? BigInt(this.cfg.targetLamports)
        : state.maxBuyLamports(tape.mint);
      if (size < BigInt(this.cfg.floorLamports)) continue;
      if (cash < size + tx * 6n) continue;
      orders.push({ side: 'buy', mint: tape.mint, quote_lamports: size, max_slippage_bps: this.cfg.buySlipBps });
      cash -= size + tx;
      tape.ordered = true;
      held += 1;
    }
    return orders;
  }

  /** Fold this batch's events into the tapes. */
  private absorb(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        this.tapes.set(e.mint, {
          mint: e.mint,
          bornSlot: e.slot,
          creator: e.creator,
          quote0: BigInt(e.virtual_quote_reserves),
          tokens0: BigInt(e.virtual_token_reserves),
          devBought: 0n,
          earlyBuyers: new Set(),
          boughtLamports: 0n,
          soldByOthers: 0n,
          worstSellBps: 0n,
          creatorDumped: false,
          ordered: false,
          closed: false,
          graduated: false,
        });
      } else if (e.event === 'TradeEvent') {
        const tape = this.tapes.get(e.mint);
        if (tape === undefined) continue;
        const sol = BigInt(e.sol_amount);
        const fromDev = e.user === tape.creator;
        if (e.is_buy) {
          tape.boughtLamports += sol;
          if (fromDev && e.slot === tape.bornSlot) tape.devBought += sol;
          else if (!fromDev) tape.earlyBuyers.add(e.user);
        } else if (fromDev) {
          tape.creatorDumped = true;
        } else {
          tape.soldByOthers += sol;
          const before = BigInt(e.real_quote_reserves) + sol;
          if (before > 0n) {
            const bps = (sol * BPS) / before;
            if (bps > tape.worstSellBps) tape.worstSellBps = bps;
          }
        }
      } else {
        // CompleteEvent: the curve graduated, nothing left to buy.
        const tape = this.tapes.get(e.mint);
        if (tape !== undefined) {
          tape.graduated = true;
          tape.closed = true;
        }
      }
    }
  }

  /** Fold this batch's fills into the holdings, and drop stale records. */
  private settleFills(state: BotState, batch: Batch): void {
    for (const f of batch.fills) {
      if (f.client_id.startsWith('_')) {
        // Harness close (flatten / complete / writeoff): position gone.
        this.holdings.delete(f.mint);
        this.exiting.delete(f.mint);
        continue;
      }
      const hold = this.holdings.get(f.mint);
      if (f.status !== 'rejected' && hold !== undefined) hold.feesPaid += BigInt(f.tx_fee_lamports);
      if (f.side === 'buy' && f.status === 'filled' && hold === undefined) {
        this.holdings.set(f.mint, {
          filledSlot: f.slot,
          feesPaid: BigInt(f.tx_fee_lamports),
          dumpedAtFill: this.tapes.get(f.mint)?.creatorDumped ?? false,
        });
      }
    }
    for (const mint of [...this.exiting]) {
      let stillOut = false;
      for (const p of state.pending.values()) {
        if (p.order.mint === mint && p.order.side === 'sell') {
          stillOut = true;
          break;
        }
      }
      if (!stillOut) this.exiting.delete(mint);
    }
    for (const mint of [...this.holdings.keys()]) {
      let pendingBuy = false;
      for (const p of state.pending.values()) {
        if (p.order.mint === mint && p.order.side === 'buy') {
          pendingBuy = true;
          break;
        }
      }
      if (!state.positions.has(mint) && !this.exiting.has(mint) && !pendingBuy) this.holdings.delete(mint);
    }
  }
}

export function createBot(cfg: ScalpConfig = SCALP_CONFIG): { onBatch(state: BotState, batch: Batch): OrderInput[] } {
  const scalper = new LaunchScalper(cfg);
  return { onBatch: (state, batch) => scalper.onBatch(state, batch) };
}

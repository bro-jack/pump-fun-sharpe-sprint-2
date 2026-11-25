// Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins.
//
// Entry point, run by the grader as `node /bot/main.ts` with this directory
// mounted at /bot. Node 22.18+ runs this TypeScript as it is: no build
// step, no dependencies, no network, no I/O beyond the harness protocol
// on stdin/stdout (handled by vendor/makefun-bot.ts).
//
// The strategy lives in strategy.ts: a launch scalper tuned for hourly
// Sharpe on a 6-hour forward replay. It buys a fresh launch only when the
// creator staked >= 0.45 SOL in the create slot AND at least 3 distinct
// non-creator buyers showed up within 2 slots — one buy per coin, target
// 0.4 SOL capped at 1% of the real reserve — and exits at +25% / -20% /
// after 10 slots / when the creator sells. Swept over seven 6-hour
// windows of the kit's 24h dataset and scored exactly like the house:
// worst window Sharpe 0.03, mean 0.31, 22-51 qualifying round trips per
// window, every window PnL > 0, max drawdown 0.0087. That clears the
// 20-mint guardrail with margin in every window, where the looser Replay
// Sprint sniper (9-16 trips per 6h) would fail it.

import { runBot } from './vendor/makefun-bot.ts';
import { createBot, SCALP_CONFIG } from './strategy.ts';

// One bot for the whole run: it carries every launch tape and holding
// across batches, so it must be created once, outside the callback.
const bot = createBot(SCALP_CONFIG);

await runBot({
  onBatch: (state, batch) => bot.onBatch(state, batch),
});

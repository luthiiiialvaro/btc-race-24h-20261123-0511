// Dip-scalper for the make.fun BTC race (agent-fun/bars-replay/v1).
//
// Idea: on 1-minute bars, wait for price to dip below its slow EMA and then
// ignite upward on a strong 1-minute bar (momentum ignition off a discount).
// That is the entry: a short-term momentum impulse, but only from a dip, never
// chasing a high. The exit is fast when wrong (tight stop) and lets winners
// run when right (trailing stop), with a hard maximum hold so capital never
// sits in a dead trade. Long only, one open position, full-size entries.
//
//   entry: close at least DIP_BPS below EMA(SLOW) and the 1-minute return
//          at least MOM_MIN_BPS, while flat and past the cooldown.
//   stop:  SL_BPS below the entry fill price.
//   trail: once price has moved TRAIL_ACT_BPS above the entry, the stop
//          ratchets to TRAIL_DIST_BPS below the highest high since entry.
//   exit:  stop, trailing stop, or MAX_HOLD_BARS bars held, whichever first.
//
// Costs matter: a full-size round trip pays about 46 bps here (4 bps fee +
// 2 bps slippage + ~17 bps of pool impact each way), so entries must catch
// moves well above that. The trailing stop is what pays for the round trip:
// losers are cut at 30 bps, winners run to 100+ bps.
//
// Deterministic: every decision is a pure function of the bars seen so far
// and hello.seed is never needed (no randomness at all). No wall clock, no
// network, no files, standard library plus the vendored shim only.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// ---- tuned parameters (graded on the frozen 24h dev window) ----
const EMA_FAST = 5;
const EMA_SLOW = 13;
const DIP_BPS = 10; // close must sit this far below EMA(SLOW)
const MOM_MIN_BPS = 10; // 1-minute return that counts as ignition
const SL_BPS = 30; // stop below the entry fill
const TRAIL_DIST_BPS = 50; // trailing stop distance below the high water
const TRAIL_ACT_BPS = 20; // trail starts once price is this far above entry
const MAX_HOLD_BARS = 240; // hard cap on minutes held
const COOLDOWN_BARS = 3; // bars to wait after an exit before re-entering
const MAX_SLIP_BPS = 300; // max slippage vs the latest close (3%)
const MIN_NOTIONAL = 1000000n; // 1 USDC, in quote units

const BPS = 10000n;

interface OpenTrade {
  price: bigint; // entry fill price
  seq: number; // batch seq where the buy fill arrived
  highWater: bigint; // highest high since entry
  sl: bigint; // current stop price
}

let emaFast = Number.NaN;
let emaSlow = Number.NaN;
let prevClose: number | null = null;
let barsSeen = 0;
let entry: OpenTrade | null = null;
let lastExitSeq = -1000000;

function updateEma(prev: number, close: number, period: number): number {
  const alpha = 2 / (period + 1);
  if (Number.isNaN(prev)) return close;
  return alpha * close + (1 - alpha) * prev;
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    if (state.warmingUp) return [];

    const closeNum = Number(bar.c);
    const closeBig = BigInt(bar.c);
    const highBig = BigInt(bar.h);
    const lowBig = BigInt(bar.l);
    emaFast = updateEma(emaFast, closeNum, EMA_FAST);
    emaSlow = updateEma(emaSlow, closeNum, EMA_SLOW);
    barsSeen += 1;

    // Fold in this batch's fills first: they tell us the true entry price.
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        const price = BigInt(fill.price);
        entry = {
          price,
          seq: state.seq,
          highWater: BigInt(bar.o),
          sl: (price * (BPS - BigInt(SL_BPS))) / BPS,
        };
      } else {
        entry = null;
      }
    }

    const pos = state.positions.get(SYMBOL);
    const qty = pos === undefined ? 0n : BigInt(pos.qty);

    if (qty > 0n) {
      // Defensive: a position with no entry record (should not happen in a
      // single run) is rebuilt from its cost basis.
      if (entry === null) {
        const cost = BigInt(pos.cost);
        const implied = (cost * 10n ** 13n) / (qty * 10n ** 6n);
        entry = {
          price: implied,
          seq: state.seq,
          highWater: closeBig,
          sl: (implied * (BPS - BigInt(SL_BPS))) / BPS,
        };
      }
      // 1. Stop hit on this bar's low.
      if (lowBig <= entry.sl) {
        lastExitSeq = state.seq;
        return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIP_BPS }];
      }      // 2. Maximum hold reached.
      if (state.seq - entry.seq >= MAX_HOLD_BARS) {
        lastExitSeq = state.seq;
        return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIP_BPS }];
      }
      // 3. Ratchet the trailing stop up on a new high, then re-check it.
      if (highBig > entry.highWater) {
        entry.highWater = highBig;
        const armed = (entry.price * (BPS + BigInt(TRAIL_ACT_BPS))) / BPS;
        if (entry.highWater >= armed) {
          const trailed = (entry.highWater * (BPS - BigInt(TRAIL_DIST_BPS))) / BPS;
          if (trailed > entry.sl) entry.sl = trailed;
        }
      }
      if (lowBig <= entry.sl) {
        lastExitSeq = state.seq;
        return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIP_BPS }];
      }
      return [];
    }

    // Flat: look for a dip + momentum-ignition entry.
    if (barsSeen <= EMA_SLOW) {
      prevClose = closeNum;
      return [];
    }
    if (state.seq - lastExitSeq < COOLDOWN_BARS) {
      prevClose = closeNum;
      return [];
    }
    const dipBps = ((closeNum - emaSlow) / emaSlow) * 10000;
    const r1 = prevClose === null ? -Infinity : ((closeNum - prevClose) / prevClose) * 10000;
    prevClose = closeNum;
    if (dipBps > -DIP_BPS || r1 < MOM_MIN_BPS) return [];

    // Full size: spend all cash, capped by the weight room.
    const room = state.weightRoom(SYMBOL);
    const notional = state.cash < room ? state.cash : room;
    if (notional < MIN_NOTIONAL) return [];
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIP_BPS }];
  },
});

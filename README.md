# Dip-Scalper: M1 momentum ignition off a discount

[![make.fun](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/luthiiiialvaro/btc-race-24h-20261123-0511/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/luthiiiialvaro/btc-race-24h-20261123-0511/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)

An entry for the [btc-race-24h-20261123-0511](https://make.fun/bounty/btc-race-24h-20261123-0511)
bounty on make.fun: a BTC trading bot that races live for 24 hours on
cbBTC/USDC, long only, starting from $1,000 paper USDC.

## Strategy

M1 scalping, but selective: the bot does not chase every 1-minute move. It
waits for price to dip below its slow EMA and then ignite upward on a strong
1-minute bar — a short-term momentum impulse entered from a discount, never
from a high.

- **Entry:** close at least 10 bps below EMA(13) **and** the 1-minute return
  at least +10 bps, while flat and past the 3-bar cooldown after an exit.
- **Stop:** 30 bps below the entry fill price.
- **Trailing stop:** once price is 20 bps above the entry, the stop ratchets
  to 50 bps below the highest high since entry, so winners run and losers
  are cut fast.
- **Max hold:** 240 minutes — capital never sits in a dead trade.
- **Size:** full cash on every entry (one open position at a time).

Why this shape: a full-size round trip costs about 46 bps here (4 bps fee +
2 bps slippage + ~17 bps of pool impact each way), so small fixed targets
lose to costs. The trailing stop is what pays for the round trip — losers
are capped at 30 bps while winners run to 100+ bps.

## Dev-window result (frozen 24h window, local grade)

- Net PnL: **+$22.31** on $1,000 starting capital
- Trades: 5 (3 wins / 2 losses, win rate 60%)
- Max drawdown: 1.94%
- Fees paid: $4.05

The result is robust across the parameter neighborhood, not a single spike:
all 180 combinations of dip 9–11 bps, momentum 8–12 bps, trail 40–80 bps,
activation 0–20 bps, hold 120–240 min and size 0.5–1.0 were positive
(+$8.40 to +$27.22), and the chosen parameters are positive on both halves
of the dev window (+$13.73 first half, +$8.54 second half).

## Files

- `main.ts` — the bot (Node 22, erasable TypeScript, standard library only).
  Every decision is a pure function of the bars seen so far: no randomness,
  no wall clock, no network, no files. Two runs on the same data produce
  byte-identical action logs.
- `vendor/makefun-bars.ts` — the kit's bars-replay SDK shim, copied
  byte-for-byte from the kit (`sdk/makefun-bars.ts`).

## Run it

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot main.ts --driver process
```

# pump-sprint-20261126-boothlord

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/borneocurrency/pump-sprint-20261126-boothlord/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/borneocurrency/pump-sprint-20261126-boothlord/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A fee-aware two-regime paper trading bot for pump.fun bonding curves, entered in make.fun's "Pump.fun Paper Sprint: Any Bot Can Win" bounty. Paper trading only — no real funds are ever moved.

## Strategy

Two regimes, one discipline: every exit is decided before the entry, and no trade is forced.

- **Pullback-survivor:** buy the dip of a curve that is still climbing. Entry needs age ≥ 250 slots, price up ≥ 70% over 150 slots with real SOL still growing (net inflow ≥ 0.5 SOL over 90 slots from ≥ 4 buyers), price 7–10% below its 60-slot high, and no net outflow in the last 30 slots. Stake 0.15 SOL; exits at +50% take-profit, −15% stop-loss, 15% trailing stop armed at +10%.
- **Breakout rider:** for runners that never dip. Buys at the 60-slot high itself, but only with stricter evidence than the pullback regime: net inflow ≥ 1.0 SOL over 90 slots from ≥ 6 buyers, trend up ≥ 15% over 150 slots. Smaller stake (0.06 SOL), tighter exits (+25% / −10% / 10% trail armed at +8%), at most one breakout entry per curve.
- **Guardrails:** total exposure capped at 6 SOL of 10 SOL capital; a round trip costs ~125bps of curve fees per side plus 105,000 lamports per order, so a trade must earn roughly 3% to break even. Tiny 0.02 SOL probe trades keep the 20-coin minimum bar in reach on the 6-hour final window; probes are insurance, not a strategy.

The bot is fully deterministic: no clock, no environment, no randomness. Two runs on the same window produce byte-identical action logs.

## Run it

```sh
node main.ts
```

The transport layer is the kit's `sdk/ts/makefun-bot.ts`, vendored byte for byte as `vendor/makefun-bot.ts`. The grader runs `node /bot/main.ts` on Node 22.

---

<sub>Entered on [make.fun](https://make.fun/?ref=&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>

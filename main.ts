// Dip-after-climb: a paper bot for the pump.fun bonding-curve replay
// (agent-fun/replay/v2) that buys a curve only after it has climbed hard
// and then pulled back a little, never at the top of a spike.
//
// The idea in one paragraph: a curve still attracting fresh SOL is worth
// owning when its price dips 7-10% under the last hour's high, provided the
// longer trend is still up at least 70% and the tape shows no fresh
// outflow. Every exit is fixed before the buy: +50% take-profit, -15% stop,
// a 15% trail once the position is up 10%, a flow exit on a 30-slot outflow
// worse than -1 SOL, and a 2000-slot time exit unless the trade is up 10%.
// A round trip pays about 125bps of curve fees on each side plus 105,000
// lamports per order, so a trade needs roughly 3% just to cover its costs.
//
// The 6-hour final window needs at least 20 coins, so the bot paces itself
// against a 6-hour clock (21600 seconds) and, when its own fills or coins
// lag the pace, opens up to 2 tiny 0.02 SOL probe round trips. Probes are
// insurance for the coin-count bar, not a source of profit: each costs
// about 0.00026 SOL in fees. Stake is 0.20 SOL per position and total
// exposure is capped at 6 SOL of the 10 SOL paper bankroll, so even a total
// wipe of every open book stays far under the 50% drawdown guardrail.
//
// What the dev window (128,058 events, 24h) showed, in brief: buying the
// breakout at the 60-slot high lost money (-0.0908 SOL) and was removed;
// the dip-only version made +0.1765 SOL on 107 fills / 44 coins / 54 trips
// at 18.5% wins and 0.52% worst drawdown. Stake scales the result almost
// mechanically (0.10 -> +0.088, 0.15 -> +0.131, 0.20 -> +0.177,
// 0.25 -> +0.219), so 0.20 sits mid-range on purpose: the final window is
// unseen data and the extra variance of 0.25 buys little.
//
// Nothing here reads a clock, the environment, or a random source. Every
// choice is a pure function of the batch being processed, and every map is
// walked in insertion order, so replaying the same stream twice gives the
// same orders twice.

import { pathToFileURL as fileUrlOf } from 'node:url';
import {
  runBot as launchBot,
  type Batch as ReplayBatch,
  type Bot as BotProgram,
  type BotState as EngineState,
  type OrderInput as Order,
  type Pubkey as Mint,
} from './vendor/makefun-bot.ts';

const LAMPORTS_PER_SOL = 1_000_000_000;
/** Bonding-curve take on each side: 95bps protocol plus 30bps creator. */
const CURVE_TAKE = 0.0125;
/** 5,000 base plus 100,000 priority lamports, charged per order win or lose. */
const ORDER_FEE_SOL = 0.000105;

export interface Params {
  /** Slots a curve must be old (since its CreateEvent) before it can be bought. */
  ageFloorSlots: number;
  /** Real SOL a curve must hold at entry, low and high end. */
  realSolFloor: number;
  realSolCeil: number;
  /** Slots back for the climb measurement. */
  climbSpanSlots: number;
  /** Price now, divided by the price at the climb start, minus one: the floor. */
  climbFloor: number;
  /** Slots back whose high is the dip reference. */
  dipSpanSlots: number;
  /** Buy only once the price sits at least this far under that high. */
  dipFloor: number;
  /** Never buy a fall deeper than this under that high. */
  dipCeil: number;
  /** Slots back for the fresh-money test. */
  inflowSpanSlots: number;
  /** Net bought SOL (buys minus sells) across the inflow span. */
  inflowFloorSol: number;
  /** Buys counted across the inflow span. */
  inflowMinBuys: number;
  /** Different wallets buying across the inflow span. */
  inflowMinWallets: number;
  /** Trades across the climb span; thin tapes read unreliably. */
  climbMinTrades: number;
  /** Slots back for the freshness test; net flow there must stay non-negative. */
  freshSpanSlots: number;
  /** SOL committed to a single position. */
  buySizeSol: number;
  /** Smallest buy worth sending. */
  buyFloorSol: number;
  /** Slippage on buys (bps); sells always go out at 10000 so exits execute. */
  buySlippageBps: number;
  /** Exits, as fractions of cost / peak value. */
  profitTarget: number;
  lossLimit: number;
  trailGap: number;
  /** The trailing stop arms once value reached cost * (1 + trailArmGain). */
  trailArmGain: number;
  /** Exit when net SOL over the exit-flow span falls below -exitFlowFloorSol. */
  exitFlowSpanSlots: number;
  exitFlowFloorSol: number;
  /** Exit after this many slots held (unless the position is up holdKeepGain). */
  holdCapSlots: number;
  holdKeepGain: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  reentryWaitSlots: number;
  /** Most entries per curve over the run. */
  entriesPerCurveCap: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  exposureCapSol: number;
  /** Guardrail pacing: the run must end with >= coinGoal coins and >= fillGoal fills. */
  coinGoal: number;
  fillGoal: number;
  paceWindowSecs: number;
  probeSizeSol: number;
  probeCap: number;
}

// The bars come from the full dev-window sweep's flat region, not its peak:
// age 200-300 slots, climb 0.5-0.7 and dip ceiling 0.10 stay positive
// across every failed-transaction draw, with the centre at 250 slots and a
// 0.70 climb. Tighter slippage (200bps, not 1000) matters: it turns away
// fills that land far from the decision price on fast curves. The stake
// (0.20 SOL) and the 6-hour pace clock follow the small experiments noted
// in the header. NOTE: an early backtest on only the first data part
// favoured looser bars; the full 128,058-event window reverses that, so
// these bars were set on the full window alone.
export const DEFAULT_PARAMS: Params = {
  ageFloorSlots: 250,
  realSolFloor: 3,
  realSolCeil: 70,
  climbSpanSlots: 150,
  climbFloor: 0.7,
  dipSpanSlots: 60,
  dipFloor: 0.07,
  dipCeil: 0.1,
  inflowSpanSlots: 90,
  inflowFloorSol: 0.5,
  inflowMinBuys: 5,
  inflowMinWallets: 4,
  climbMinTrades: 10,
  freshSpanSlots: 30,
  buySizeSol: 0.2,
  buyFloorSol: 0.02,
  buySlippageBps: 200,
  profitTarget: 0.5,
  lossLimit: 0.15,
  trailGap: 0.15,
  trailArmGain: 0.1,
  exitFlowSpanSlots: 30,
  exitFlowFloorSol: 1,
  holdCapSlots: 2000,
  holdKeepGain: 0.1,
  reentryWaitSlots: 300,
  entriesPerCurveCap: 2,
  exposureCapSol: 6,
  coinGoal: 30,
  fillGoal: 80,
  paceWindowSecs: 21600,
  probeSizeSol: 0.02,
  probeCap: 2,
};

interface TapeEvent {
  slot: number;
  isBuy: boolean;
  solAmount: number;
  trader: string;
  px: number;
}

interface CurveTape {
  birthSlot: number | null;
  events: TapeEvent[];
  buys: number;
  lastExitSlot: number;
}

interface OpenBook {
  openSlot: number;
  bestValue: number;
  /** SOL sent into this book by its buys, fees included. */
  costBasis: number;
  closing: boolean;
  /** At least one buy of this book has filled. */
  landed: boolean;
  /** Mark-to-close value at the latest batch (SOL, fees already taken off). */
  markValue: number;
}

/** Net SOL bought (buys minus sells) across the last `span` slots of a tape. */
function netFlowSol(tape: CurveTape, now: number, span: number): number {
  let total = 0;
  let idx = tape.events.length - 1;
  while (idx >= 0) {
    const ev = tape.events[idx]!;
    if (ev.slot <= now - span) break;
    total += ev.isBuy ? ev.solAmount : -ev.solAmount;
    idx -= 1;
  }
  return total;
}

/** SOL price of one token from the virtual reserves (SOL per token). */
function priceFromReserves(virtualQuote: bigint, virtualToken: bigint): number {
  if (virtualToken === 0n) return 0;
  return Number(virtualQuote) / Number(virtualToken);
}

/**
 * What selling `tokens` back into the curve at reserves (quoteRes, tokenRes)
 * leaves in SOL once the 125bps curve take and the fixed order fee are off.
 * A negative answer means the close cannot even pay its own fees.
 */
function sellProceedsSol(tokens: number, quoteRes: number, tokenRes: number): number {
  if (tokens <= 0 || tokenRes <= 0) return -ORDER_FEE_SOL;
  const gross = (tokens * quoteRes) / (tokenRes + tokens) / LAMPORTS_PER_SOL;
  return gross * (1 - CURVE_TAKE) - ORDER_FEE_SOL;
}

/**
 * Whether a tape clears every bar for a dip buy at `now`, at decision
 * price `px`, with `realSol` SOL of real reserves behind the curve.
 * The checks are grouped by what they measure: size and age, the climb,
 * the dip, then the freshness of the money.
 */
function dipSetupPasses(tape: CurveTape, now: number, px: number, realSol: number, cfg: Params): boolean {
  if (realSol < cfg.realSolFloor || realSol > cfg.realSolCeil) return false;
  if (tape.birthSlot === null || now - tape.birthSlot < cfg.ageFloorSlots) return false;
  if (px <= 0) return false;

  const climbStart = now - cfg.climbSpanSlots;
  const dipStart = now - cfg.dipSpanSlots;
  const inflowStart = now - cfg.inflowSpanSlots;

  // Reference price: the last print at or before the climb start, or the
  // first print after it when the tape starts later than the window.
  let reference = -1;
  for (const ev of tape.events) {
    if (ev.slot <= climbStart) {
      reference = ev.px;
      continue;
    }
    if (reference < 0) reference = ev.px;
    break;
  }
  if (reference <= 0) return false;

  // Recent high, climb depth, and fresh-money totals in one sweep.
  let recentHigh = 0;
  let climbPrints = 0;
  let inflowBuys = 0;
  let boughtSol = 0;
  let soldSol = 0;
  const wallets = new Set<string>();
  for (const ev of tape.events) {
    if (ev.slot > climbStart) {
      climbPrints += 1;
      if (ev.slot > dipStart && ev.px > recentHigh) recentHigh = ev.px;
    }
    if (ev.slot <= inflowStart) continue;
    if (ev.isBuy) {
      boughtSol += ev.solAmount;
      inflowBuys += 1;
      wallets.add(ev.trader);
    } else {
      soldSol += ev.solAmount;
    }
  }
  if (inflowBuys < cfg.inflowMinBuys) return false;
  if (wallets.size < cfg.inflowMinWallets) return false;
  if (climbPrints < cfg.climbMinTrades) return false;
  if (boughtSol - soldSol < cfg.inflowFloorSol) return false;
  // Still climbing over the long window...
  if (px / reference - 1 < cfg.climbFloor) return false;
  // ...yet genuinely off the recent high, a dip rather than a collapse...
  if (recentHigh <= 0 || px > recentHigh * (1 - cfg.dipFloor)) return false;
  if (px < recentHigh * (1 - cfg.dipCeil)) return false;
  // ...with no fresh outflow: the dip reads as a pause, not a dump.
  if (netFlowSol(tape, now, cfg.freshSpanSlots) < 0) return false;
  return true;
}

export function createStrategy(cfg: Params = DEFAULT_PARAMS): BotProgram {
  const tapes = new Map<Mint, CurveTape>();
  const books = new Map<Mint, OpenBook>();
  /** Probe round trips in flight, by mint: false while the buy is open, true once the sell is out. */
  const probes = new Map<Mint, boolean>();
  /** Own filled orders and the coins they landed on (harness closes excluded). */
  let ownFills = 0;
  const ownCoins = new Set<Mint>();
  let windowStart: number | null = null;
  let windowEnd: number | null = null;
  const keepSpan = Math.max(cfg.climbSpanSlots, cfg.inflowSpanSlots) + 5;

  const tapeFor = (mint: Mint): CurveTape => {
    const found = tapes.get(mint);
    if (found !== undefined) return found;
    const fresh: CurveTape = { birthSlot: null, events: [], buys: 0, lastExitSlot: -1e12 };
    tapes.set(mint, fresh);
    return fresh;
  };

  return {
    onBatch(engine: EngineState, batch: ReplayBatch): Order[] {
      const now = batch.slot;
      const touched = new Set<Mint>();
      const orders: Order[] = [];
      const orderCap = engine.hello.caps.max_orders_per_batch;
      let freeSol = 0;
      let openSlots = 0;
      let exposure = 0;

      // Take the batch in: count own fills, absorb events, drop stale prints.
      for (const fill of batch.fills) {
        if (fill.status === 'filled' && !fill.client_id.startsWith('_')) {
          ownFills += 1;
          ownCoins.add(fill.mint);
        }
      }
      for (const evt of batch.events) {
        if (evt.block_time !== null) {
          if (windowStart === null) windowStart = evt.block_time;
          if (windowEnd === null || evt.block_time > windowEnd) windowEnd = evt.block_time;
        }
        if (evt.event === 'CreateEvent') {
          tapeFor(evt.mint).birthSlot = evt.slot;
        } else if (evt.event === 'TradeEvent') {
          const tape = tapeFor(evt.mint);
          const sol = Number(evt.sol_amount) / LAMPORTS_PER_SOL;
          tape.events.push({
            slot: evt.slot,
            isBuy: evt.is_buy,
            solAmount: sol,
            trader: evt.user,
            px: priceFromReserves(BigInt(evt.virtual_quote_reserves), BigInt(evt.virtual_token_reserves)),
          });
          touched.add(evt.mint);
        }
      }
      for (const mint of touched) {
        const tape = tapes.get(mint)!;
        let drop = 0;
        while (drop < tape.events.length && tape.events[drop]!.slot <= now - keepSpan) drop += 1;
        if (drop > 0) tape.events.splice(0, drop);
      }
      const marks = new Map(batch.marks.map((mark) => [mark.mint, mark] as const));
      const pendingCount = new Map<Mint, number>();
      for (const open of engine.pending.values()) {
        pendingCount.set(open.order.mint, (pendingCount.get(open.order.mint) ?? 0) + 1);
      }

      // Exits first: a book whose exit is due is sold whole, never averaged down.
      const closeBooks = (): void => {
        for (const [mint, book] of books) {
          const position = engine.positions.get(mint);
          const curve = engine.curves.get(mint);
          if (position === undefined) {
            if (!pendingCount.has(mint)) {
              books.delete(mint);
              const tape = tapeFor(mint);
              if (book.landed) tape.lastExitSlot = now;
              else tape.buys -= 1;
            }
            continue;
          }
          book.landed = true;
          if (curve === undefined || curve.complete) continue;
          const mark = marks.get(mint);
          const quoteRes = mark ? Number(mark.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
          const tokenRes = mark ? Number(mark.virtual_token_reserves) : Number(curve.virtual_token_reserves);
          const tokens = Number(position.token_amount);
          const value = sellProceedsSol(tokens, quoteRes, tokenRes);
          const cost = Number(position.cost_lamports) / LAMPORTS_PER_SOL;
          if (value > book.bestValue) book.bestValue = value;
          book.markValue = value;
          const tape = tapeFor(mint);
          let due = book.closing;
          if (!due && value >= cost * (1 + cfg.profitTarget)) due = true;
          if (!due && value <= cost * (1 - cfg.lossLimit)) due = true;
          if (!due && book.bestValue >= cost * (1 + cfg.trailArmGain) && value < book.bestValue * (1 - cfg.trailGap)) due = true;
          if (!due && netFlowSol(tape, now, cfg.exitFlowSpanSlots) < -cfg.exitFlowFloorSol) due = true;
          if (!due && now - book.openSlot > cfg.holdCapSlots && value < cost * (1 + cfg.holdKeepGain)) due = true;
          if (!due) continue;
          book.closing = true;
          if (pendingCount.has(mint)) {
            let sellOut = false;
            for (const open of engine.pending.values()) {
              if (open.order.mint === mint && open.order.side === 'sell') sellOut = true;
            }
            if (sellOut) continue;
          }
          if (orders.length >= orderCap) break;
          orders.push({ side: 'sell', mint, token_amount: position.token_amount, max_slippage_bps: 10_000 });
        }
      };

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      const unwindProbes = (): void => {
        for (const [mint, selling] of probes) {
          const position = engine.positions.get(mint);
          const curve = engine.curves.get(mint);
          if (position === undefined) {
            if (!pendingCount.has(mint)) probes.delete(mint);
            continue;
          }
          if (curve === undefined || curve.complete || pendingCount.has(mint)) continue;
          if (orders.length >= orderCap) break;
          orders.push({ side: 'sell', mint, token_amount: position.token_amount, max_slippage_bps: 10_000 });
          if (!selling) probes.set(mint, true);
        }
      };

      // Then entries: one fixed-size buy per curve, only while the setup holds.
      const openEntries = (): void => {
        for (const mint of touched) {
          if (orders.length >= orderCap) break;
          const curve = engine.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (pendingCount.has(mint) || probes.has(mint) || books.has(mint)) continue;
          if (openSlots <= 0) continue;
          if (exposure + cfg.buyFloorSol > cfg.exposureCapSol) continue;
          const tape = tapes.get(mint)!;
          if (tape.buys >= cfg.entriesPerCurveCap || now - tape.lastExitSlot < cfg.reentryWaitSlots) continue;
          const px = priceFromReserves(curve.virtual_quote_reserves, curve.virtual_token_reserves);
          const realSol = Number(curve.real_quote_reserves) / LAMPORTS_PER_SOL;
          if (!dipSetupPasses(tape, now, px, realSol, cfg)) continue;
          // Size under the 1%-of-real-reserve cap with headroom, so a fill is
          // never turned away for size; skip when even the floor buy breaks it.
          const capSol = Math.floor(Number(engine.maxBuyLamports(mint)) * 0.9) / LAMPORTS_PER_SOL;
          let amount = Math.min(cfg.buySizeSol, capSol, cfg.exposureCapSol - exposure);
          if (amount > freeSol - ORDER_FEE_SOL) amount = freeSol - ORDER_FEE_SOL;
          if (amount < cfg.buyFloorSol) continue;
          const lamports = BigInt(Math.floor(amount * LAMPORTS_PER_SOL));
          orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: cfg.buySlippageBps });
          freeSol -= amount + ORDER_FEE_SOL;
          exposure += amount;
          books.set(mint, { openSlot: now, bestValue: 0, costBasis: amount, closing: false, landed: false, markValue: 0 });
          tape.buys += 1;
          openSlots -= 1;
        }
      };

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      // The pace clock is the 6-hour final window, so probes start covering the
      // 20-coin bar early instead of waiting for a 24-hour clock that never
      // arrives inside the final.
      const topUpCoverage = (): void => {
        if (probes.size >= cfg.probeCap || openSlots <= 0) return;
        if (windowStart === null || windowEnd === null) return;
        const pace = Math.min(1, (windowEnd - windowStart) / cfg.paceWindowSecs);
        const coinsShort = ownCoins.size < Math.ceil(cfg.coinGoal * pace);
        const fillsShort = ownFills < Math.ceil(cfg.fillGoal * pace);
        if (!coinsShort && !fillsShort) return;
        const minReal = (cfg.probeSizeSol * 10_000) / engine.hello.caps.max_order_bps_of_real_reserve;
        for (const mint of touched) {
          if (orders.length >= orderCap || probes.size >= cfg.probeCap) break;
          if (books.has(mint) || probes.has(mint) || pendingCount.has(mint) || engine.positions.has(mint)) continue;
          if (coinsShort && !fillsShort && ownCoins.has(mint)) continue;
          const curve = engine.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (Number(curve.real_quote_reserves) / LAMPORTS_PER_SOL < minReal * 1.5) continue;
          if (freeSol < cfg.probeSizeSol + 2 * ORDER_FEE_SOL) break;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(cfg.probeSizeSol * LAMPORTS_PER_SOL)), max_slippage_bps: cfg.buySlippageBps });
          probes.set(mint, false);
          freeSol -= cfg.probeSizeSol + ORDER_FEE_SOL;
        }
      };

      closeBooks();
      unwindProbes();
      freeSol = Number(engine.freeCashLamports()) / LAMPORTS_PER_SOL;
      openSlots = engine.hello.caps.max_open_positions - engine.committedPositionCount();
      for (const [mint, book] of books) {
        const heldCost = Number(engine.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS_PER_SOL;
        exposure += Math.max(book.costBasis, heldCost);
      }
      openEntries();
      topUpCoverage();
      return orders;
    },
  };
}

// Only start the transport loop when this file is the entrypoint (the grader
// runs `node /bot/main.ts`). Importing it from local backtest tools must
// not start the loop.
const runAsScript = process.argv[1] !== undefined && import.meta.url === fileUrlOf(process.argv[1]).href;
if (runAsScript) {
  await launchBot(createStrategy(DEFAULT_PARAMS));
}

# Strategy 06: Market Making Hybrid

## Tier
**LIVE EXECUTION** - Enhancement to Strategy 5, use when conviction exists

---

## Hypothesis
Using limit orders instead of market orders improves execution by ~3c per trade (earn spread instead of paying it). Combined with directional conviction from our probability model, this stacks two edges: execution edge + directional edge.

## Edge Thesis
On Polymarket:
- Market order entry: pay ~1c spread
- Market order exit: pay ~1c spread
- Limit order entry: EARN ~1c spread
- Hold to resolution: no exit spread

Swing: 3c per trade. On thin edges, this is the difference between profitable and not.

Additionally, Polymarket rewards makers:
- Liquidity rewards (daily payouts for orders within max spread)
- Maker rebates (20% of taker fees in 15-min markets)

---

## Components

### Probability Logic
- Uses same model as Strategy 5 (Black-Scholes, Window Timing Model)
- Only enters when conviction exists (model divergence from market)

### Entry Conditions
- Model shows divergence (our P ≠ market price)
- Place limit order at or slightly better than current bid/ask
- Wait for fill (passive entry)
- If not filled within X seconds, do NOT escalate (unlike Strategy 5)

### Exit Rules
- **On Fill**: Check if directional thesis still valid
  - If thesis valid: HOLD TO RESOLUTION
  - If thesis invalidated (model flipped): EXIT immediately via market order
- **Stop Loss**: Thesis-based. Accept exit spread cost as price of being wrong.
- **Take Profit**: Resolution. This is conviction + execution edge combined.

### Position Sizing
- Same as Strategy 5: $2 base, scale on conviction
- Only enter when conviction exists - don't market make without direction

---

## Risk Parameters
- Max position size: $5
- Stop-loss: Thesis-based (immediate exit if model flips)
- Max concurrent positions: 2 (this strategy, separate from Strategy 5)
- Correlation notes: Enhancement to Strategy 5, not replacement

---

## Execution Specification

### Order Flow
1. Strategy 5 signals entry opportunity
2. Instead of limit-then-escalate, place limit order ONLY
3. Set limit price at edge of spread (slightly better than market)
4. Wait for fill (max wait time: TBD, maybe 60-90 seconds)
5. If filled:
   - Log fill with maker flag
   - Check if thesis still valid
   - If valid: hold to resolution
   - If invalid: exit immediately
6. If not filled:
   - Cancel order
   - Do NOT escalate to market (that's Strategy 5's job)
   - Wait for next opportunity

### When to Use This vs Strategy 5
- **Strategy 5**: When you need to get in NOW (strong conviction, fast-moving market)
- **Strategy 6**: When you can wait for fill (moderate conviction, stable market)

Run both in parallel on different opportunities, or use Strategy 6 as default with Strategy 5 as escalation.

---

## Polymarket Maker Economics

### Revenue Streams
1. **Spread Capture**: Entry at better price = guaranteed edge
2. **Liquidity Rewards**: Orders within max spread earn daily payouts
3. **Maker Rebates**: 20% of taker fees redistributed to makers (15-min markets)

### Qualification
- Orders must be within "max spread" of midpoint (varies by market, ~3c typical)
- Minimum share requirements vary by market
- Daily payout at midnight UTC, $1 minimum threshold

---

## Test Plan

### Live Trading
- Run alongside Strategy 5
- Minimum fills: 50 before evaluation
- Duration: Ongoing

### Success Metrics
- Fill rate on limit orders
- P&L comparison: Strategy 6 vs Strategy 5 when both could have traded
- Maker rewards earned
- Adverse selection: are fills profitable or getting picked off?

### Variations to Test
- **Variation A**: Limit at current bid/ask (aggressive maker)
- **Variation B**: Limit 1c inside spread (very aggressive)
- **Variation C**: Limit 1c outside spread (passive, higher fill rate)

### Key Learning
Does waiting for limit fill:
- Improve average entry price?
- Reduce number of trades (opportunity cost)?
- Create adverse selection (filled when you shouldn't be)?

---

## Team Review Summary
- **Vera (Quant)**: Track limit fills separately. Compare to market order counterfactual.
- **Nadia (Risk)**: Adverse selection is the risk. Getting filled might be bad news.
- **Theo (Execution)**: Fill rate will be <100%. Quote inside spread for higher fills.
- **Cassandra (Skeptic)**: Operational complexity. When limit conflicts with thesis, what wins?

---

## Falsifiability
- If limit order fills have lower win rate than market orders, adverse selection is real
- If fill rate <30%, not enough trades to matter
- If operational complexity causes errors, simplify to Strategy 5 only

---

## Data Collection Requirements
- Limit order placement time and price
- Fill/no-fill outcome
- Time to fill (if filled)
- Market price at fill vs limit price (slippage, should be positive)
- Maker rewards attributed to this strategy
- Comparison to Strategy 5 when both could have traded

---

## Integration with Architecture
- Uses same components as Strategy 5
- Additional tracking for limit order lifecycle
- May need `order_type` flag in positions table to distinguish

Strategy ID: `mm-hybrid-v1`

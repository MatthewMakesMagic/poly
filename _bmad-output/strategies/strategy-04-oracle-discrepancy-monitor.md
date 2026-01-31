# Strategy 04: Oracle Discrepancy Monitor

## Tier
**Observation Only** (No trading until validated)

---

## Hypothesis
The market misreads how the Oracle will resolve because: (a) Oracle calculation is opaque to most participants, (b) Oracle has its own lag relative to underlying exchanges, (c) participants don't understand Oracle methodology. Our multi-exchange feed can model Oracle resolution better than the market.

## Edge Thesis
Information asymmetry. We stream prices from multiple exchanges to build a more accurate model of what the Oracle will actually report. When our model diverges from market expectation, one of us is wrong. If we're right more often, there's edge.

---

## Components

### Probability Logic
- Stream spot prices from multiple exchanges (Binance, Coinbase, Kraken, etc.)
- Model Oracle calculation: how does Oracle aggregate these feeds?
- Predict: what will Oracle report at window resolution?
- Compare: our Oracle prediction vs market price

### Entry Conditions
**NOT TRADING YET** - Observation only

When we graduate to trading:
- Our Oracle model diverges from market by >X cents
- High confidence in model prediction
- Entry in direction our model favors

### Exit Rules
**NOT TRADING YET**

When we graduate:
- Hold to resolution (this is about predicting resolution correctly)
- No early exit - we're testing Oracle prediction accuracy

### Position Sizing
**NOT TRADING YET**

When we graduate:
- Size based on divergence magnitude and model confidence
- Small size until model proves reliable

---

## Risk Parameters
- During observation: $0 at risk
- When live: TBD based on observed accuracy

---

## Observation Plan

### Data Collection
- Log every window (500+ minimum before any trading)
- For each window, record:
  - Our multi-exchange spot prices (with timestamps)
  - Our Oracle prediction
  - Market price at various times
  - Actual Oracle resolution
  - Divergence between our prediction and market

### Success Metrics
- Our Oracle prediction accuracy vs market price accuracy
- Frequency of meaningful divergence events
- Magnitude of divergence when it occurs

### Live Graduation Criteria
- Our model outperforms market on 100+ divergence events
- Divergence events occur frequently enough to trade (>5% of windows)
- Model accuracy is >60% when divergence is meaningful (>5c)

---

## Team Review Summary
- **Vera (Quant)**: Low frequency = sample size problem. 500+ observations needed.
- **Nadia (Risk)**: No capital risk in observation. Good approach.
- **Theo (Execution)**: Oracle timing is everything. Must understand Oracle update frequency.
- **Cassandra (Skeptic)**: Your model might be wrong. Oracle methodology might change.

---

## Falsifiability
- If our model predictions match market 95%+ of time, no divergence to exploit
- If divergences occur but our model is wrong as often as right, no edge
- If divergence events are <2% of windows, insufficient opportunity

---

## Data Collection Requirements
- Multi-exchange spot feeds (Binance, Coinbase, Kraken, OKX, etc.)
- Timestamps with millisecond precision
- Oracle resolution values and timestamps
- Market prices throughout window
- Polymarket Oracle documentation/methodology

---

## Key Questions to Answer During Observation
1. How does Polymarket's Oracle aggregate exchange prices?
2. What's the lag between exchange prices and Oracle updates?
3. Does our multi-exchange model predict Oracle better than single-exchange?
4. When does market diverge from our model, and who's right?
5. Are there specific conditions (high vol, low liquidity) where divergence is more common?

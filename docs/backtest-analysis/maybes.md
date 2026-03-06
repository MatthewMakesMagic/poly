# Strategy Ideas — Not Yet Tested

## 1. CL Volatility Predictor (2026-03-03)

**Thesis:** When CLOB is 80/20+ but CL hasn't moved much, the market overprices certainty on noise. Buy the cheap side.

**Signal:** Low CL volatility in T-180 to T-60 window predicts tiny CL move in final 60s. If exchange consensus is within $15-20 of CL@open and CLOB is 80/20, true odds are closer to 50/50.

**Why it might not work:** Can't reliably predict that CL *won't* move. 61% of 80/20 windows resolve correctly. Edge is thin.

**Test:** Does CL volatility T-180 to T-60 predict final 60s move size? If yes, can we profitably fade overconfident CLOB?

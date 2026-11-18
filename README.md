# Implied Radar v3 — token-radar-01

[![token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/)
[![rank](https://make.fun/badge/token-radar-01/LeviosaEXC/token-radar-01-implied-radar-v3/rank.svg)](https://make.fun/)
[![reward](https://make.fun/badge/token-radar-01/LeviosaEXC/token-radar-01-implied-radar-v3/reward.svg)](https://make.fun/)

A board of the 198 pre-token protocols in the snapshot, ranked by implied
value if launched, with a farm plan, a verdict, and an uncertainty band per
row — plus a dashboard that re-derives every number it shows and proves it
in the browser.

## What shipped

The value model is a rung ladder over a global power law, fitted on 88
traded comps by Huber regression: R0 is the bare curve, R1 adds age, R2
adds breadth, R3 adds shrunk category offsets, R4 adds growth, each blended
toward the curve with a weight in {0, .25, .5, .75, 1}. 21 candidates ran
nested leave-one-out, a five-origin walk-forward, and a 200-permutation
placebo, behind four shipping gates (G1–G4).

**No challenger cleared G1.** The best nested-LOO gain (R2, s=1) was 0.0538
dex against a bar of 0.0699 dex — the 95th percentile of the null gain,
because the selection procedure ships a challenger in 68.5% of target
permutations. The entry therefore ships R0, the global power law, and says
so on the page: "Gate Failed; Fallback to Global Power Law." That is a
passing outcome under the spec, not an error, and the full 21-candidate
ledger with G1–G4 verdicts is on the Model tab.

Two findings are printed rather than worked around:

- **Walk-forward is vacuous here.** All 34 held-out rows fall outside their
  fold's support box (each is younger than its whole training window, so
  its age percentile is 0), so every challenger collapses to the curve at
  every origin: Δ ≡ 0.0000. G2/G3 pass vacuously; the decision rests on
  G1 (failed) and G4.
- **The launch table failed its Brier gate** (0.1044 vs 0.1030 TVL-logistic,
  2/5 fold signs), so it ships as a diagnostic column beside the assumed
  odds and the tiers keep the assumption. Every appearance is labeled a
  cross-sectional launch share, not a forward probability.

Measured on the snapshot (2026-11-14, 758 protocols): nested LOO 0.5186
dex / 3.30×; shipped-model LOO 0.5398 dex / 3.47×, Spearman 0.3324; flat
baseline 0.6162 dex. Value-band LOO coverage 50.0% / 79.5% (nominal
50%/80%). Rank coverage 79.5%, median shipped width 131.5 rows. Tiers:
171 SKIP, 27 THIN, 0 ROBUST, 0 FARM — no row earns a farm verdict at the
$1,000 headline size once gas and the break-even odds are counted honestly,
so the third screenshot shows the top THIN row's drawer instead of a
ROBUST one that does not exist.

## Run it

Node 22+, standard library only. The program reads a snapshot, writes the
board, the dashboard (with generated data), the screenshots, and the
dossier:

```sh
node main.ts --input <snapshot.json> --output /tmp/out
```

It runs in ~45 seconds locally (ceiling 120s) and is byte-identical across
runs: same SHA-256 on board.json, every dashboard file, every screenshot,
and dossier.json. The dossier text is 65,107 bytes (cap 65,536, 429 spare);
the dossier is 953,939 bytes (cap 1.5 MiB).

## Verify it

```sh
node verify.mjs --out /tmp/out --snapshot <snapshot.json> --repo . \
  --kitvendor <kit>/starter/vendor/makefun-board.ts
```

44 checks: board shape, ranks, monotonicity, watchlist 40/40, farm-step
bounds, census sums, ledger consistency, dossier caps, screenshot
size/dimensions, vendor byte-identity, and the no-leakage greps (no
category or chain literals in model/scoring code, no launch terms in the
primary rank, no name-to-offset tables). The dashboard additionally proves
itself live: it re-derives all 198 rows from raw fields plus embedded
parameters (values, bands, rank intervals, verdicts, farm steps via
digests) and shows `Recompute verified 198/198 · drift $0` with an audit
badge. Open `dashboard/index.html` from any output directory — no network,
no storage, no external resources.

## Layout

- `main.ts` — the whole program: census, rung ladder, gates, bands, launch
  table, verdicts, board, dashboard data, dossier.
- `dashboard/` — the page source: `index.html`, `app.css`, `app.js`.
  `data.js` is generated at run time, never committed.
- `screenshots/` — the three captures the program ships: radar, gate
  ledger, one row's drawer.
- `vendor/makefun-board.ts` — the kit's dossier library, byte-for-byte.
- `verify.mjs` — the verification record above.

## Notes

- The dashboard shows implied values at two significant figures, display
  only; full precision is retained internally and the recompute check
  compares display strings.
- Gas tiers use the snapshot's chain spellings (`Binance`,
  `Hyperliquid L1`); the brief text says `BNB`/`Hyperliquid`. Same tier,
  disclosed on the page and here.
- All 21 candidates, all 200 placebo permutations, all five walk-forward
  origins, and every ablation are printed with measured numbers and
  measured standard errors. Nothing is smoothed over: the gates failed,
  the fallback shipped, and the page says so.

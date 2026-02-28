---
name: feature-forge
description: Create or improve high-conviction, explainable trading features and alpha signals end-to-end (ideation, research, feasibility checks, prototyping, validation, and integration). Use when asked to invent new features or signals, improve existing features with deep research, build an edge-alpha feature factory, turn research into production features, or combine weak signals into a single robust feature.
---

# Feature Forge

## Read this first
- **Existing docs are not completion:** if `docs/research/feature-forge/<feature>-research.md` or `docs/research/feature-forge/<feature>-experiment.md` already exist, continue in-place; verify each gate’s exit criteria is satisfied, then keep strengthening the docs (fill gaps, add sources/formulas, append Variant blocks with decisions).

## Mission
Create or improve a trading feature that is:
- **Explainable:** has a clear economic story and expected sign.
- **Robust:** stable out-of-sample and not dependent on fragile tuning.
- **General by default:** **asset-agnostic** unless explicitly justified as asset-specific.
- **Regime-aware:** either stable across regimes, or explicitly **conditioned/gated** by a regime signal.
- **Deployable:** uses live-available inputs and fits runtime/latency budgets.

## Operating rules (bias-resistant)
- **Pre-register gates before results:** write pass/fail criteria *before* running diagnostics.
- **Evidence > intuition:** research and diagnostic outputs are the source of truth.
- **Traceability:** every decision must point to (a) a formula, (b) code location, and (c) the command used to evaluate it.
- **No reference = not research:** any prior-art claim must include a URL/DOI/arXiv/repo reference; if no usable prior art exists, include a documented negative search.
- **Causal timing only:** use only information available at time *t* (no lookahead, no revised fields).
- **Simplicity wins:** among candidates that meet gates, select the simplest and most interpretable variant.

## Quick Start
```
/feature-forge <idea>
/feature-forge <feature>
/feature-forge theme:funding-sentiment
/feature-forge combine <feat1> <feat2> <feat3>
/feature-forge improve <feature>
```

## Required artifacts (write these as you work)
- Research notes (sources + formulas + rationale): `docs/research/feature-forge/<feature>-research.md`
- Experiment log (commands + readouts + decisions): `docs/research/feature-forge/<feature>-experiment.md`
- Workshop implementation (no production edits yet): `experiments/feature_forge/feature_workshop.py`
- Workshop backups: `experiments/feature_forge/backups/`

## Workflow (gate-based)

### G0: Frame the problem (write this first)
**Objective:** define what success means *before* experimentation.

**Actions:**
- Define the feature’s role: directional alpha vs regime filter vs risk control vs meta-signal.
- Declare generality targets up front:
  - **Asset scope:** asset-agnostic (default) vs asset-specific (must justify).
  - **Regime plan:** regime-invariant vs regime-gated/split (define regime signal + how it conditions the feature).
- Define pass/fail gates (examples):
  - OOS sign consistency, stability/decay, cross-asset consistency, turnover/cost sensitivity, runtime budget.
- Write these gates down now; before running any diagnostics, record them under `## Gates (pre-registered)` in the research notes and copy them into the baseline block in the experiment log.
- Define input availability constraints:
  - required fields must be computable live with correct timing.
  - if an input is not available live, keep it research-only (do not integrate).

**Exit criteria:** you can state the hypothesis, expected sign, inputs, asset scope, regime plan, and gates succinctly.

### G1: Theory and confounders (baseline spec)
**Objective:** define the mechanism and the minimal *theoretical* formulation before doing literature mining.

**Actions:**
- Write the one-sentence economic story and expected sign.
- Draft the minimal formula at the math/logic level (what inputs, what transforms, what normalization).
- Identify confounders (trend, volatility, liquidity, microstructure) and how you will neutralize or gate against them.
- State the regime expectation: regime-invariant vs explicitly regime-gated/split (and why).
- Keep this section theory-only: do **not** mention backtest outcomes or metrics (IC, Sharpe, PnL, OOS, win rate).
- Start the research notes file (even if it only contains the baseline spec at first): `docs/research/feature-forge/<feature>-research.md`.

**Exit criteria:** you can write the baseline formula + expected sign + confounder plan without referencing backtest results.

### G1R: Prior art scan (mandatory)
**Objective:** avoid iterating on a strawman; establish what “known good” formulations look like.

**Actions:**
- Scope: this is a one-time broad scan; loop-specific research happens in G4R.
- Find prior art relevant to the mechanism (academic/practitioner writeups, open-source implementations).
- Extract: **formula**, **normalization**, typical parameter heuristics, and known failure modes (especially regime dependence).
- Record in `docs/research/feature-forge/<feature>-research.md`.
- Include a direct reference (URL/DOI/arXiv/repo) for each extracted formulation; do not rely on memory.
- If nothing usable is found, document a “negative search” (queries + why results were not usable).

**Exit criteria:** `docs/research/feature-forge/<feature>-research.md` contains either a prior-art formulation to test or a documented negative search.

### G2: Data viability and timing integrity
**Objective:** ensure the feature is testable and live-implementable without leakage.

**Actions:**
- Verify fields exist, are synchronous, and do not revise after the fact.
- Check missingness, stale values, and extreme outliers.
- Confirm units and scaling; prefer dimensionless ratios and bounded/robust transforms.
- Shift anything that could leak (funding, OI, derived stats) to its true availability time.

**Exit criteria:** you can explain why the feature uses only time-*t* information and how NaNs/outliers are handled.

### G3: Prototype baseline (minimal valid anchor)
**Objective:** implement the simplest correct version to anchor all comparisons.

**Actions:**
- Establish **one** minimal, interpretable baseline anchor.
  - If improving an existing production feature, treat the current implementation as the baseline (run diagnostics with `--source engine`) unless it fails gates or no longer matches the intended spec.
  - Otherwise, implement the baseline in `experiments/feature_forge/feature_workshop.py`.
  - Do not “search” for a baseline by trying many variants here; alternatives belong in G4.
- Prefer shared utilities for indicators and scaling (see G6) to avoid drift from production.
- Record the baseline `code_location` (file + symbol) in the experiment log.
- Create/append the baseline block in `docs/research/feature-forge/<feature>-experiment.md`.
- Run diagnostics on the baseline (command below) and log readouts/flags.

**Exit criteria:** baseline (source + code location) + diagnostic output are recorded in the experiment log.

**Stop:** do not build variants in G3. Proceed to G4R and use the baseline diagnostics to choose the first question/flag to address.

### G4: The RBVD Loop (research ↔ build ↔ validate ↔ decide)
**Objective:** systematically explore meaningful alternatives and converge with evidence.

**Rule:** you stay in G4 until you log `decision=stop` with a valid `stop_condition`. A `keep` is not an exit.

**Loop unit:** one diagnosed variant = one `change_vs_baseline` + one `formula` + one diagnostics run.

**Flow (repeat):** G4R -> G4B -> G4V -> G4D -> (continue -> G4R) | (stop -> G5)

**Batching (allowed):** one G4R pass may yield multiple candidate variants; update research notes once, then run G4B→G4V→G4D **one variant at a time** (Variant block per variant; refs can be reused).

#### G4R: Research (mandatory)
- Pick **one** question tied to evidence: *Which one flag/readout/prior-art delta am I addressing next?* (prioritize must-resolve flags first).
- Pull in prior art or critiques relevant to that question:
  - Collect competing formulations (academic/practitioner writeups, open-source implementations).
  - Capture exact formulas and normalization choices (not just descriptions).
  - Record the expected sign, typical lookback heuristics, and known failure modes (especially regime dependence).
  - Update the confounder plan (trend, volatility, liquidity, microstructure): neutralize, gate, or accept explicitly.
- Prior-art rule: if viable prior art exists, implement a formulation “as written” before introducing hybrids; if none exists, document a negative search and proceed with a clearly-labeled first-principles variant.
- Gate: update `docs/research/feature-forge/<feature>-research.md` with sources (or a negative search) before proceeding to G4B.

#### G4B: Build (one conceptual change per variant)
- Implement a variant that represents a **conceptual** change (not just parameter shuffling), such as:
  - alternative signal definition (mechanism), alternative normalization, robustness/outlier handling,
  - explicit regime gating/splitting, turnover control/smoothing, confounder neutralization.
- Even when the baseline is `--source engine`, build variants in the workshop (do not edit production until G6).
- For “indicator/normalization” variants, prefer shared utilities (see G6) before inventing new implementations; deviate only with a logged reason.
- Keep variants atomic: one conceptual change per variant, with a clear `change_vs_baseline`.
- Practical rule: write `change_vs_baseline` as one sentence; if you need “and”, split into multiple variants.
- No orphan variants: if you cannot state the `hypothesis/question` in one sentence, do not build the variant.

#### G4V: Validate (diagnostics + regime sanity)
- Run diagnostics on the variant and compare to the baseline.
- If the baseline is `--source engine`, keep the baseline block as the engine run and run variant diagnostics with `--source experiment` (compare blocks).
- Do a regime sanity check:
  - either show the signal behaves consistently across regimes,
  - or convert regime dependence into an explicit gate/split and document it.

#### G4D: Decide (log + decision)
- **Log (required):** for each diagnosed variant, append or update one Variant block in `docs/research/feature-forge/<feature>-experiment.md` using the Variant Output Contract.
  - Diagnosed variant = one `change_vs_baseline` + one `formula` + diagnostics run.
  - If you re-run diagnostics for the same variant (same `change_vs_baseline` and `formula`), update the existing block; create a new block only when the change/formula changes.
- **Gate (must pass):** a Variant block is only valid if:
  - all Output Contract fields are filled,
  - `evidence` references your pre-registered `gates` and cites specific `key_readouts` and `flags`,
  - at least one of `research_refs` / `negative_search` is present (both allowed),
  - if `decision=refine` then `next_loop_question` is set,
  - if `decision=stop` then `stop_condition` is set.
- **Decision:** choose exactly one and write it in the block:
  - `keep`: add it to the candidate set; then continue to G4R (next strongest formulation from this research pass, or the next highest-priority flag/readout).
  - `discard`: record why; then continue to G4R (next strongest formulation, or the next question).
  - `refine`: set `next_loop_question` as a single sentence tied to a failure mode/readout; then go to G4R and answer it with the next variant.
  - `stop`: only when a Stop condition is met; set `stop_condition` and justify it in `evidence` (this is the only way to exit G4).
    - If `stop_condition=research exhausted`, `negative_search` must include the follow-up queries (prompted by the latest diagnostics) and where you searched.

**What does *not* count as progress:** score-chasing, random sweeps, or repeatedly changing lookbacks without a research-backed reason.

**Stop conditions (this is the exit gate for G4; must document):**
- **Converged / plateau:** after testing the strongest competing formulations you found (or documenting via negative search that no viable alternatives exist), further meaningful conceptual changes do not improve `key_readouts`, resolve must-resolve flags, or change the decision. A single “keep” without a challenger does not qualify.
- **Research exhausted:** after a documented prior-art scan and a follow-up search driven by diagnostic results (not a single pass), remaining alternatives are either (a) already tested, (b) not live-implementable with available inputs, or (c) collapse into the same mechanism after normalization.
- **Fail fast (documented):** the idea is structurally invalid (leakage / non-live inputs / timing) or keeps violating gates across plausible formulations; stop and drop or re-scope the hypothesis.

### G5: Selection and pruning
**Objective:** choose the smallest set of features that add unique, stable edge.

**Actions:**
- Precondition: G4 ended with `decision=stop` and a documented `stop_condition`; if not, return to G4.
- Precondition: the experiment log contains a diagnosed baseline **and** at least one diagnosed alternative variant, each with a written decision; if not, return to G4.
- Precondition: variants in the experiment log include `research_refs` or `negative_search`; if not, return to G4.
- Precondition: the selected candidate has no must-resolve flags (or they are explicitly justified with evidence in the experiment log); if not, return to G4.
- Select the simplest candidate that clears gates and beats the baseline on stability and deployability.
- Tie-breaker: if multiple candidates clear gates, prefer fewer inputs/transforms/knobs and lower runtime.
- If improving, run a combine-or-replace decision:
  - test correlation + residual OOS IC versus adjacent/overlapping features.
  - deprecate redundant clones; keep only the minimum set that adds incremental edge.

**Exit criteria:** one “winner” is chosen (or the idea is dropped) with a written justification.

### G6: Implementation and integration
**Objective:** ship the winner safely and make it maintainable.

**Actions:**
- Pick the right home based on runtime budget and implementation constraints:
  - Python is fine for vectorized operations; avoid per-row loops and `apply`.
  - If runtime fails budget or you need per-bar loops, redesign or move the computation to Rust.
- For TA-style indicators, prefer shared helpers over re-implementations:
  - `from aegis.infrastructure.utils import polars_indicators as pl_ta`
- Normalize using shared utilities (prefer monotone, bounded transforms; neutral = 0.5):
  - `src/aegis/infrastructure/adapters/feature_engines/feature_scaling.py`
- Handle edge cases explicitly:
  - guard divisions with eps, clip/winsorize unstable ratios, replace invalid denominators with NaN then `fillna(0.5)`.
  - prefer soft gates: `0.5 + (signal - 0.5) * gate` (gate in [0, 1]) over hard thresholds.
- Register the feature with a clear description, expected sign meaning, and input requirements.
- Add/update tests and run targeted checks.

**Exit criteria:** production implementation + tests + documentation exist; workshop version is no longer the source of truth.

### G7: Monitoring plan
**Objective:** detect drift and regressions in live usage.

**Actions:**
- Track rolling IC/coverage/turnover and drift metrics.
- Alert on sign flips, coverage drops, or runtime regressions.
- Periodically re-run null/leakage checks on recent data.

## Diagnostics (must run)

Workshop / experiment feature:
```bash
./scripts/feature-forge/run.sh <feature> --source experiment
```

Existing production feature (when improving an engine feature):
```bash
./scripts/feature-forge/run.sh <feature> --source engine
```

Multiple features:
```bash
./scripts/feature-forge/run.sh rsi macd mom_rank --parallel
```

Key switches (see `--help` for the full list):
- `--cost-bps`: cost sensitivity for edge metrics.
- `--neutralize`: recompute IC after removing common confounders (trend/vol/volume proxies).
- `--perf-sluggish-ms`: SLUGGISH flag threshold (ms per 8000 bars; default: 30).
- `--perf-warn-ms`: SLOW flag threshold (ms per 8000 bars; default: 50).
- Interaction diagnostics:
  - `--no-interaction-checks`: disable interaction parents + uplift diagnostics.
  - `--interaction-auto`: auto-select N parents (>=2 enables).
  - `--interaction-uplift-min`: minimum IC uplift vs parents (INTERACTION_NO_UPLIFT threshold).
  - `--interaction-edge-uplift-min`: minimum net-edge uplift vs parents (INTERACTION_NO_EDGE_UPLIFT threshold).
- Horizon checks: use the horizon sensitivity controls to detect label-horizon tuning.
- Regime flags: tune sensitivity with `--regime-min-abs-ic` and `--regime-drop-thresh`.

Build manually (if wrapper fails):
```bash
cd scripts/feature-forge
PYO3_PYTHON=$(which python3.12) cargo build --release
```

## Diagnostic flag playbook (cause → fix)
Use this when diagnostics raise flags. Prefer fixing root causes over suppressing output.
- Implementation tip: prefer shared helpers (see G6) before re-implementing indicators/scaling.

Must-resolve:
- **LEAKAGE_RISK**: verify inputs are known at time *t*; shift/replace suspect inputs; add negative controls.
- **SIGN_FLIP**: treat as regime dependence or inversion error; add regime gate/split, neutralize confounders, simplify normalization.
- **REGIME_SIGN_FLIP**: IC flips sign across regime slices (vol/trend). Do not ship as unconditional alpha; gate/split explicitly or reframe as a regime filter.
- **HIGH_DECAY**: reduce degrees of freedom; use rank/robust transforms; reduce implicit tuning; lengthen or stabilize estimation windows.
- **SLOW**: remove Python loops/`apply`; reuse intermediates; prefer shared utilities (see G6); move heavy work to Rust if needed.

Often-problematic:
- **INTERACTION_NO_UPLIFT** (leaf-only): adding the feature to its best parent set does not improve OOS IC. Only fires for features not used as parents by other active features.
  - Weak standalone edge (often also **LOW_EDGE**): redundant → drop/rework.
  - Strong standalone edge: keep if you want redundancy; but don't claim ensemble improvement without evidence.
- **INTERACTION_PARENT_DOMINATES** (leaf-only): a parent dominates OOS while uplift stays below threshold. Only fires for leaf features. Treat as redundancy; drop/replace.
- **SLUGGISH**: close to the runtime budget; optimize hot paths, remove loops/`apply`, reuse intermediates, and consider shared utilities (see G6) or Rust if it trends toward SLOW.
- **HORIZON_SENSITIVE**: reduce horizon tuning; use multi-scale designs; introduce explicit regime gating or smoothing.
- **REGIME_UNSTABLE**: IC varies materially across regime slices (including sign flip). Make the regime dependence explicit (gate/split) or drop the idea.
- **UNSTABLE**: simplify; increase robustness; clip tails; use rank transforms; neutralize trend/vol proxies.
- **LOW_EDGE**: reduce turnover; target higher-conviction regimes; drop if costs dominate.

## Templates (copy/paste)

Conventions (keep logs consistent):
- For list-like fields (`research_refs`, `negative_search`, `key_readouts`, `flags`), write one item per line prefixed with `- `.
- Use `research_refs` for URLs/DOIs/repos; use `negative_search` for query + where + why.

### Research notes: `docs/research/feature-forge/<feature>-research.md`
```
# <feature>

## Hypothesis
- Economic story:
- Expected sign:
- Role (alpha / regime / risk / meta):

## Confounders and controls
- Confounders:
- Neutralization/gating plan:
- Regime definition + conditioning plan:

## Generality targets
- Asset scope: asset-agnostic | asset-specific (justify)
- Regime plan: invariant | gated | split (define the regime signal)

## Gates (pre-registered)
- Must-pass:
- Nice-to-have:

## Sources and formulations
- Source:
  - Notes:
  - Formula:
  - Normalization:
  - Known failure modes / regime notes:

## Negative search log (when applicable)
- Query:
  - Where searched:
  - Why not usable:

## Candidate plan
- Baseline:
- Variants to test (ideas only; build and diagnose in G4 one at a time):
```

### Experiment log: `docs/research/feature-forge/<feature>-experiment.md`
Baseline:
```
feature:
code_location:  # file + symbol (e.g., src/.../engine.py:my_feature)
baseline_formula:
inputs:
asset_scope:
regime_plan:
gates:
diagnostic_command:
key_readouts:  # 3-6 numbers from diagnostics (not prose)
flags:
decision:
evidence:  # why readouts/flags justify the decision vs gates
```

Variant Output Contract (append one per diagnosed variant):
```
variant_id:
code_location:  # file + symbol (workshop or engine)
addresses:  # baseline_flag:<FLAG> | readout:<NAME> | prior_art_delta:<SHORT>
hypothesis/question:  # one sentence
change_vs_baseline:  # one conceptual change (if you need “and”, split into multiple variants)
research_refs:  # URLs/DOIs/repos used this loop (can be empty if negative_search is filled)
negative_search:  # queries + where searched (required if research_refs is empty; optional otherwise)
formula:
regime_handling:  # invariant | gated_by:<signal> | split_by:<signal> (and how)
diagnostic_command:
key_readouts:  # 3-6 numbers from diagnostics (not prose)
flags:
decision: keep | refine | discard | stop (why)
evidence:  # link key_readouts/flags to the decision and gates
next_loop_question:  # required when decision=refine
stop_condition:  # required when decision=stop (plateau | research exhausted | fail fast)
```

## Completion checklist
- [ ] Hypothesis + expected sign + role are documented.
- [ ] Inputs are live-available and timing is correct (no leakage).
- [ ] Asset scope is explicit (asset-agnostic by default; asset-specific is justified).
- [ ] Regime behavior is understood (stable across regimes or explicitly gated/split).
- [ ] Gates are pre-registered (research notes + baseline block) before diagnostics.
- [ ] Research notes include sources + extracted formulas (or documented negative searches).
- [ ] Baseline implemented and diagnosed; experiment log includes commands + readouts.
- [ ] Iteration loop includes meaningful conceptual variants with written decisions + evidence.
- [ ] No must-resolve flags remain unresolved (or they are explicitly justified with evidence).
- [ ] Redundancy checked; only non-overlapping winners are integrated.
- [ ] Production integration completed with tests and monitoring plan.

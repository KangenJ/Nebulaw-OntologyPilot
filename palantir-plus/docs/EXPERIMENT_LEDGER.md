# Experiment ledger: active learning of ontology Logic

This ledger is a compact research report, not a claim that every experiment
was a success. Each entry keeps the same chain: question → intervention →
result → interpretation → next design choice. Internal hostnames, user names,
absolute server paths, credentials, and private data locations are omitted.
References use repository-relative names or logical artifact names.

## How to read the record

The object being learned is bounded Logic: candidate rules, evidence weights,
state transitions, and action values over an explicit ontology. The system must
keep world state, belief state, observations, permissions, and executed actions
separate. A score from a fixed executor or planner is not counted as a learned
model capability.

“Failed” means that a registered gate was not met, a comparison was not
identifiable, or an engineering assumption did not survive the test. A failed
route is retained because it explains the next design choice.

## 1. From rule recovery to typed Logic (P10–P18)

| Route | What was tried | What became clear | Why the next route changed |
| --- | --- | --- | --- |
| P10–P12 | Recurrent updating, active value, and definition-conditioned posterior mechanisms | Updating and posterior definitions need explicit conditions; a single undifferentiated rule representation is ambiguous. | Separate definitions, observations, and transitions before increasing model capacity. |
| P13–P14 | Public definitions, raw AST confirmation, and compositional typed transition posterior | Surface-form or raw-AST matching did not by itself establish semantic recovery; typed transition structure was needed. | Freeze public definitions and test whether typed composition is identifiable on held-out structures. |
| P15–P18 | Deeper guards, demonstration posterior, and posterior repair | Longer chains and repair mechanisms increased the need for explicit guard semantics and independent confirmation. | Treat planning depth, posterior repair, and mechanism change as separate experiments. |

**Logic lesson.** The ontology is not a text label set. A candidate change must
state which definition, evidence condition, transition, permission, or temporal
relation it changes.

## 2. Active identification and structured dynamics (P19–P35)

| Route | What was tried | Result or limitation | Why the next route changed |
| --- | --- | --- | --- |
| P19–P21 | Candidate-free typed rules, active identification, and variable anchors | The experiments moved from selecting among hand-named candidates toward testing whether the available probes could identify a bounded rule. | Require prospective probe budgets and report identifiability separately from prediction quality. |
| P22–P24 | Structured threshold posterior, compositional dynamics, and calibrated set value | Active selection could be evaluated only with explicit uncertainty, costs, and a frozen evaluation protocol. | Keep posterior, value, and transition mechanisms as separate modules. |
| P25–P29 | Learned belief value, nonuniform planning, action-set interaction, search heuristics, and cutoff-aware search | Learned selectors and heuristics could look better against weak controls; strong fixed and exhaustive controls were required. | Make the strongest finite planner the primary reference and treat learned search as an optional component. |
| P30–P32 | Stochastic bridge, frozen confirmation, and active-identification headroom | A bridge between normative/evidence variables and stochastic behavior required frozen confirmation and a headroom analysis. | Do not present a bridge or headroom result as general rule discovery. |
| P33–P35 | Normative-to-behavior alignment, catalogue/posterior variants, continuous posterior feasibility | Several parameterizations were feasible as development tools, but feasibility was not evidence of transfer or neural advantage. | Freeze a small, auditable reference and test stability, missing conditions, and independent seeds. |

**Why this mattered.** The research direction changed from “learn a rule” to
“learn or update a bounded belief about Logic, choose the next informative
observation, and validate a candidate transition under explicit permissions.”

## 3. Learned behavior versus strong finite baselines (P36–P40)

| Experiment | Intervention | Result | Decision |
| --- | --- | --- | --- |
| P36 / P36b | Training diversity and optimization of a small behavior model | Produced frozen candidates for later comparison; training success alone was not treated as a scientific result. | Keep the model checkpoint and training receipt separate from evaluation claims. |
| P37 | Missing-condition analysis | Exposed cases where apparent recovery was not identifiable from the available conditions. | Add missing-condition and identifiability checks before confirmation. |
| P38 | Short-chain confirmation against finite statistical ablations | The neural three-step route did not establish a clear advantage over the registered finite controls. | Do not expand the neural chain to chase the score; retain the negative result. |
| P39 | Strong-kernel benchmark | `FINITE48 + BAYES32` was stronger than the all-neural comparison under the registered tolerance; the neural CPU path was also slower in the measured setup. | Use the strongest finite kernel as the primary reference for later value claims. |
| P40 | Behavior seed stability | Seed variation was tested under a frozen training and evaluation protocol rather than selecting the best run. | Separate stability across seeds from the existence of one good checkpoint. |

**Failure-driven decision.** Because the neural route did not demonstrate
additional value over the finite reference, subsequent experiments focused on
what the ontology Logic system must do—identify, observe, update, and act—rather
than on making the neural component larger.

## 4. Adaptation, interactions, and observation history (P41–P56)

| Route | What was tested | What it was for | Boundary kept in the record |
| --- | --- | --- | --- |
| P41 | A fixed Logic×feedback interaction and a five-coefficient adaptation model | Test whether a known interaction can be identified from a designed set of demonstrations. | Known interaction identification is not unknown interaction discovery. |
| P44–P50 | Shared readout, streaming episodes, parameter ranges, observation shift, factorized observation, pooled missingness, and local full update | Stress the fast-learning layer under altered observations and missing feedback. | Improvement on one shifted condition does not solve forgetting or broad transfer. |
| P51–P54 | Anchor identifiability and longer belief horizons | Check whether beliefs remain identifiable and calibrated as history length grows. | Horizon extension is not evidence that the system can maintain arbitrary long-term state. |
| P55–P56 | Temporal state change and hazard-mixture routes | Test nonstationarity and mixture structure explicitly. | Unresolved or negative stability cases remain exclusions from the public claim. |

**Design consequence.** Adaptation is treated as a fast candidate update. It
cannot rewrite stable ontology Logic directly; a slow consolidation gate must
use replay, holdouts, counterfactuals, conflict checks, and rollback.

## 5. From information value to feedback action (P57–P60)

### P57 → P58: active observation

**Question.** Is an observation worth its cost when the policy can choose which
verification to perform?

**Intervention.** Freeze the strategy selected in development, use new mechanism
families and evaluation streams, and compare statistical active selection with
strong fixed-channel and fixed-order controls. Evaluate a neural selector
separately for quality and cost.

**Confirmation.** P58 reports statistical active loss of `0.082817` versus
`0.093780` for the strong fixed-channel control and `0.110278` for fixed order;
the two registered statistical confirmation gates passed with illegal action
rate zero. The neural selector met the stated quality tolerance but had higher
loss than the statistical policy and failed the cost-value gate in the measured
CPU setup.

**Interpretation.** Active observation is useful in the bounded synthetic
environment. The evidence does not show that the neural selector is better,
cheaper, or legally effective in reality.

### P59 → P60: two-step feedback

**Question.** After an action produces a new observation, does updating the
belief and choosing again outperform a short-sighted or precommitted plan?

**Intervention.** Freeze the rules, costs, actions, and development strategy;
evaluate a new parameter index and random stream; enumerate legal branches; and
compare closed-loop feedback, short-sighted selection, and an open-loop fixed
two-step plan.

**Confirmation.** P60 reports:

| Strategy | Total loss | Action/observation cost | Terminal failure probability |
| --- | ---: | ---: | ---: |
| Observe, update, choose again | 0.362659 | 0.057126 | 0.305533 |
| Fix both steps in advance | 0.381890 | 0.052458 | 0.329432 |
| Short-sighted selection | 0.395244 | 0.047030 | 0.348215 |

The closed-loop strategy reduced total loss by 8.24% versus the short-sighted
policy and 5.04% versus the precommitted plan. The legal-branch, evidence
boundary, and planning-optimality checks passed.

**Interpretation.** In this finite synthetic setting, feedback can improve the
next Logic action when the system updates its belief before acting again. P60
did not train a neural network and does not establish unknown-mechanism
discovery, real legal effectiveness, or a complete autonomous learning loop.

## 6. What the sequence supports

The cumulative result is a method claim with explicit limits:

1. Represent Logic as typed definitions, evidence conditions, transitions,
   permissions, and temporal effects rather than as an undifferentiated text
   prediction target.
2. Maintain a bounded belief state and use active observations to reduce the
   uncertainty that matters for the next permitted action.
3. Separate statistical planning, learned parameterizations, and deterministic
   execution when attributing a result.
4. Treat feedback as a reason to update a candidate belief, not as permission
   to rewrite stable ontology Logic.
5. Promote a candidate only after independent evaluation, counterfactual or
   replay checks, conflict checks, and rollback metadata are available.

The sequence does **not** support claims of general legal intelligence,
real-world legal validity, unrestricted rule discovery, or a neural model that
outperforms the strongest finite statistical reference.

## 7. Public artifact convention

Internal execution locations are represented by stable logical paths:

| Internal detail | Public reference |
| --- | --- |
| Private run directory | `artifacts/<experiment>/` |
| Training output | `models/<model-id>/` |
| Evaluation entry point | `runtime/<entry-point>.py` |
| Private input or customer data | `DATA_NOT_PUBLIC` with provenance note |
| Host, user, or absolute path | Removed |

The [artifact index](ARTIFACT_INDEX.md) maps experiment IDs to the public
registration, code, report, and result-summary names. A model or result is not
called reproducible until its input version, code revision, environment, and
hash are recorded.

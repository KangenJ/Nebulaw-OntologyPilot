# Experiment artifact index

This index keeps the public names short and auditable. It does not expose
private hostnames, user names, absolute paths, credentials, or restricted data.
Where a result is not included in the current public snapshot, the registration
name is retained as a research record and the missing artifact is marked for
release review.

## Primary chain

| Experiment | Registration | Code / test entry | Report or result |
| --- | --- | --- | --- |
| P36b | `P36B_OPTIMIZATION_DEV_REGISTRATION.md` | `runtime/` training and scoring entry to be selected during packaging | `P36B_*_RESULT.md` if approved for release |
| P38 | `P38_SHORT_CHAIN_CONFIRMATION_REGISTRATION.md` | `runtime/` short-chain runner | `P38_SHORT_CHAIN_CONFIRMATION_RESULT.md` |
| P39 | `P39_STRONG_KERNEL_BENCHMARK_REGISTRATION.md` | finite-kernel benchmark entry | `P39_STRONG_KERNEL_BENCHMARK_RESULT.md` |
| P40 | `P40_BEHAVIOR_SEED_STABILITY_REGISTRATION.md` | seed-stability runner | `P40_BEHAVIOR_SEED_STABILITY_RESULT.md` when released |
| P57 | `P57_OBSERVATION_VALUE_REGISTRATION.md` | `runtime/run_p57_observation_value_v0_9.py` | `P57_OBSERVATION_VALUE_RESULT.md` |
| P58 | `P58_OBSERVATION_VALUE_CONFIRM_REGISTRATION.md` | `runtime/run_p58_observation_confirm_v0_9.py` | `P58_OBSERVATION_VALUE_CONFIRM_RESULT.md` |
| P59 | `P59_TWO_STEP_FEEDBACK_REGISTRATION.md` | `runtime/run_p59_two_step_feedback_v0_9.py` | `P59_TWO_STEP_FEEDBACK_RESULT.md` |
| P60 | `P60_TWO_STEP_FEEDBACK_CONFIRM_REGISTRATION.md` | `runtime/run_p60_feedback_confirm_v0_9.py` | `P60_TWO_STEP_FEEDBACK_CONFIRM_RESULT.md` |

## Supporting experiment families

| Family | Registration range | Public purpose |
| --- | --- | --- |
| Definitions and transitions | P10–P18 | Establish typed definitions, guards, posterior repair, and compositional transitions. |
| Identification and planning | P19–P35 | Test probes, belief value, search, stochastic bridges, and feasibility limits. |
| Training and stability | P36–P40 | Separate training behavior, seed stability, and strong finite baselines. |
| Adaptation and observations | P41, P44–P56 | Test interactions, streaming, shifts, missingness, horizons, and nonstationarity. |
| Observation and feedback | P57–P60 | Confirm active observation and feedback-driven re-selection. |

## Required provenance for a released artifact

Each released model or result should add:

- experiment ID and version;
- source commit;
- input or generator version;
- configuration and seed;
- environment lock;
- file size and SHA256;
- exact reproduction command;
- license and data-use status;
- known exclusions and negative results.

Until these fields are filled, an artifact remains a research reference rather
than a public downloadable model.

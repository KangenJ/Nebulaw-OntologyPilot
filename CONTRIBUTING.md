# Contributing

Nebulaw-Ontology Pilot is a research project and reference implementation. Contributions should help clarify, test, or safely extend the Logic learning architecture.

## Principles

- Keep Open Foundry as the business object and governance substrate; do not create a parallel source of business truth.
- Distinguish observations, verified facts, model estimates, assumptions, and action outcomes.
- Do not treat a successful computation as approval. Preserve permission, version, source, and audit checks.
- Mark synthetic, mock, and real data separately. Do not present an experimental candidate as a deployed capability.
- Preserve failures and regressions. Add new evidence rather than rewriting historical results.

## Local validation

Run the smoke suite before submitting a change:

    npm run test:smoke

The smoke suite is not full platform acceptance. Changes involving permissions, concurrency, persistence, or publication should include failure-path tests and explain any untested scope.

Research changes should freeze the data split, evaluation metric, budget, and baseline before tuning. Report label cost, failures, regressions, and the boundary of the claim.

## Pull request checklist

1. State the problem and scope.
2. Identify whether the change affects a public component, an experimental candidate, or documentation.
3. List tests run, tests not run, and why.
4. Describe compatibility, data, licensing, and security impact.
5. State the reproducibility method and known limitations.

Never commit credentials, customer data, private deployment configuration, unauthorized weights, or internal infrastructure details.

# Plus contracts

Pure ontology-binding compiler for Plus v2. No storage writes, model calls or domain-specific legal parameters.

Inputs are a `MechanismDefinition` and server-owned `CompilerContext`: full ODL `ParsedSchema`, actual SPI schema, gated native manifest registry, persistent schema revision, and purpose-scoped compilation policy. Callers must not accept the policy or registry from request bodies.

Exports:

- `compileDefinition`: validates field/link/action references, semantics, value dictionaries, budgets and typed module writes; produces an immutable-by-value dependency snapshot. `predictionReady` is always false: compilation is not model approval.
- `checkCompatibility`: detects snapshot tampering, revoked bindings and changed dependencies. Unrelated additive fields do not invalidate a definition.
- `validateTypedValue`: validates finite scalars, enums, bounded lists and native `(tenantId,type,id,version)` references without coercion. Reference authorization remains a runtime obligation.
- `projectSourceValue`: performs approved bucket conversion and preserves UNOBSERVED/MISSING/UNKNOWN/REVOKED separately from observed false.

CONTROL parameters use `ActionBinding.parameters` plus the native action's typed field definition, rather than pretending action input is an already stored business property. The runtime must supply ROOT/SERVER parameters itself, render and validate INPUT parameters against the pinned action contract, and enforce approval again before execution.

This package does not establish causal edges, authenticate users, validate real-world truth, enforce CEL effects, publish schemas, or train models. Those are separate runtime/governance tasks; do not call compiler success a completed Plus deployment.

Build and verify from `platform/` with the project's pinned Node/pnpm:

```sh
pnpm --filter @openfoundry/plus-contracts build
pnpm --filter @openfoundry/plus-contracts typecheck
pnpm --filter @openfoundry/plus-contracts test
```

The 37 current tests use the real ODL parser. The second fixture is a non-legal three-category machine ontology. `ops/plus-v2/t01-native-contract-check.mjs` separately probes actual pre-migration domain packs and proves unpublished task attributes are rejected. That probe is explicitly baseline-only and will be retired after approved v2 ontology migration.

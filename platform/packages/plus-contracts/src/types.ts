import type { ParsedSchema, FieldTypeRef } from '@openfoundry/odl';
import type { OntologySchema } from '@openfoundry/spi';

export type Atom = string | number | boolean;
export type VariableRole = 'FACT' | 'OBSERVATION' | 'LATENT' | 'CONTEXT' | 'RULE_DERIVED';
export interface SourceBinding {
  objectType: string;
  field: string;
  path?: { linkType: string; direction: 'INBOUND' | 'OUTBOUND'; aggregation: 'ONE' | 'LATEST' | 'COUNT' };
}
export interface VariableSpec {
  key: string;
  role: VariableRole;
  source: SourceBinding;
  valueType: string;
  nullable: boolean;
  unit: string;
  support: Atom[];
  unknownValues: Atom[];
  missingPolicy: { absent: 'UNOBSERVED'; null: 'MISSING'; withdrawn: 'REVOKED' };
  time: { eventTimeField: string; receivedTimeField: string;
    /** Reviewed unchanged initial prefix only; requires complete native history. */
    initial?: { eventTimeField: string; receivedTimeField: string } };
  verification: { policyRef: string; mode: 'NONE' | 'GOLD' | 'NOISY' };
  accessPolicyRef: string;
  transform: { kind: 'IDENTITY' } | { kind: 'BUCKET'; edges: number[] };
}
export interface MechanismModule {
  key: string;
  kind: 'TRANSITION' | 'OBSERVATION' | 'RULE';
  inputs: string[];
  outputs: string[];
  dependsOn: string[];
  implementation: string;
}
export interface ActionBinding {
  key: string;
  nativeAction: string;
  effect: 'INFORMATION_ONLY' | 'STATE_TRANSITION';
  parameters: Record<string, 'ROOT' | 'INPUT' | 'SERVER'>;
}
export interface MechanismDefinition {
  schema: 'plus-mechanism-v1';
  key: string;
  revision: number;
  title: string;
  rootType: string;
  scope: { key: string; policyRef: string };
  variables: VariableSpec[];
  modules: MechanismModule[];
  actions: ActionBinding[];
  budget: { mechanisms: number; horizon: number; alternatives: number; branchDepth: number };
  utility: { target: string; decisions: Atom[]; losses: number[][]; verificationCost: number; minimumDifference: number; unit: string };
}
export interface ManifestShape {
  action: string;
  version: number;
  preconditions: unknown[];
  effects: unknown[];
  sideEffects: unknown[];
  [key: string]: unknown;
}
/** Supplied by authenticated platform code, never by the definition author. */
export interface CompilationPolicy {
  id: string;
  readableFields: string[];
  actionNames: string[];
  implementationIds: string[];
  scopePolicies: string[];
  verificationPolicies: string[];
  /** Approved semantics not necessarily expressible by current ODL. */
  fieldSemantics: Record<string, { unit: string; roles: VariableRole[]; knowledgeOnlyValues?: Atom[] }>;
  initialContextTimes?: Record<string, { eventTimeField: string; receivedTimeField: string }>;
}
export interface CompilerContext {
  parsed: ParsedSchema;
  spiSchema: OntologySchema;
  manifestRegistry: { get(name: string): unknown };
  schemaRevision: string;
  policy: CompilationPolicy;
}
export interface CompiledVariable extends VariableSpec {
  sourceType: FieldTypeRef;
  sensitive: boolean;
  referenceType?: string;
}
export type ProjectedValue = { kind: 'VALUE'; value: unknown } | { kind: 'UNKNOWN'; marker: Atom }
  | { kind: 'UNOBSERVED' | 'MISSING' | 'REVOKED' };
export interface CompiledDefinition {
  schema: 'plus-compiled-v1';
  definition: MechanismDefinition;
  definitionHash: string;
  schemaRevision: string;
  storageSchemaVersion: number;
  policyHash: string;
  dependencyHash: string;
  dependencies: Record<string, unknown>;
  variables: CompiledVariable[];
  moduleOrder: string[];
  jointStateCount: number;
  readiness: 'DEFINITION_VALIDATED';
  /** Compilation does not approve a model or establish data readiness. */
  predictionReady: false;
}

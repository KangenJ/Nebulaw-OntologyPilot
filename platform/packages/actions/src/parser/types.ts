/**
 * Action manifest types.
 *
 * These types represent the parsed and validated structure of a YAML action
 * manifest per Open Foundry spec Section 5.1.
 */

// ─── Effect types (discriminated union) ───

export interface UpdateObjectEffect {
  type: 'updateObject';
  target: string;
  set: Record<string, string>;
  condition?: string;
}

export interface CreateLinkEffect {
  type: 'createLink';
  linkType: string;
  from: string;
  to: string;
  properties?: Record<string, string>;
  condition?: string;
}

export interface DeleteLinkEffect {
  type: 'deleteLink';
  linkType: string;
  filter: {
    from?: string;
    to?: string;
    active?: boolean;
  };
  expect?: 'ONE' | 'ALL';
}

export interface CreateObjectEffect {
  type: 'createObject';
  objectType: string;
  /** Explicit unique binding for batch plans; never overwrites input variables. */
  as?: string;
  properties: Record<string, string>;
}

/**
 * Record a consent decision for a subject (governed, audited). `subject` is an
 * expression resolving to the consent subject id (e.g. "patient"). `purpose`
 * defaults to DIRECT_CARE, `decision` to GRANT. `condition` (CEL) gates whether
 * the consent is recorded — used for opt-out (e.g. consent-on-register unless
 * `params.consent == false`). Consent is recorded via the ConsentManager, which
 * is outside the SPI transaction — place it as the terminal effect.
 */
export interface RecordConsentEffect {
  type: 'recordConsent';
  subject: string;
  purpose?: string;
  decision?: string;
  evidence?: string;
  condition?: string;
}

export type ActionEffect =
  | UpdateObjectEffect
  | CreateLinkEffect
  | DeleteLinkEffect
  | CreateObjectEffect
  | RecordConsentEffect;

// ─── Precondition ───

export interface Precondition {
  expr: string;
  error: string;
}

// ─── Side effects ───

export interface SideEffect {
  name: string;
  type: string;
  config: Record<string, unknown>;
  retries?: number;
  retryDelay?: string;
}

// ─── Rollback policy ───

export type RollbackPolicy = 'LOG_AND_CONTINUE' | 'RETRY_INDEFINITELY' | 'ROLLBACK_ALL';

export interface RollbackConfig {
  onSideEffectFailure: RollbackPolicy;
}

// ─── Undo configuration ───

export interface UndoOverride {
  effect: number;
  undoEffect: Record<string, unknown>;
}

export interface UndoConfig {
  overrides?: UndoOverride[];
  sideEffects?: SideEffect[];
  window?: string;
}

// ─── Action Manifest (top-level) ───

export interface ActionManifest {
  /** Must match an @actionType name in the ODL schema. */
  action: string;
  /** Manifest version (integer). */
  version: number;
  /** Whether this action supports undo. Default: false. */
  reversible: boolean;
  /** CEL expressions that must evaluate to true before execution. */
  preconditions: Precondition[];
  /** Sequential mutations applied within a single transaction. */
  effects: ActionEffect[];
  /** Async operations triggered after effects commit. */
  sideEffects: SideEffect[];
  /** Rollback policy for side-effect failures. */
  rollback?: RollbackConfig;
  /** Optional undo configuration (only if reversible=true). */
  undo?: UndoConfig;
}

// ─── Validation result ───

export type ManifestIssueSeverity = 'error' | 'warning';

export interface ManifestIssue {
  severity: ManifestIssueSeverity;
  code: string;
  message: string;
  /** Dot-path to the offending field (e.g. "effects[0].target"). */
  path?: string;
}

export interface ManifestValidationResult {
  valid: boolean;
  manifest?: ActionManifest;
  errors: ManifestIssue[];
  warnings: ManifestIssue[];
}

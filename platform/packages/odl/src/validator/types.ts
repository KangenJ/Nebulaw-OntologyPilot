/**
 * ODL Validator result types.
 */

export type ValidationSeverity = 'error' | 'warning';

export interface ValidationIssue {
  /** Severity: errors prevent schema application, warnings are advisory. */
  severity: ValidationSeverity;
  /** Machine-readable error code (e.g., 'MISSING_PRIMARY'). */
  code: string;
  /** Human-readable description. */
  message: string;
  /** The type name where the issue was found. */
  typeName?: string;
  /** The field name where the issue was found. */
  fieldName?: string;
}

export interface ValidationResult {
  /** true if no errors (warnings are allowed). */
  valid: boolean;
  /** Issues that prevent the schema from being applied. */
  errors: ValidationIssue[];
  /** Style issues or potential problems. */
  warnings: ValidationIssue[];
}

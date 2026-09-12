/**
 * Field provenance tracking (Section 4.6).
 */

import type { DateTime } from './scalars.js';

export interface FieldProvenance {
  tenantId: string;
  objectType: string;
  objectId: string;
  field: string;
  valueHash: string;
  producedAt: DateTime;
  source: ProvenanceSource;
}

export type ProvenanceSource =
  | { kind: 'ACTION'; actionType: string; actionId: string; actor: string }
  | { kind: 'SYNC'; connector: string; sourceSystem: string; syncRunId: string; mappingVersion: string; sourcePointer: string }
  | { kind: 'FUNCTION'; functionName: string; functionVersion: string; inputRefs: string[] };

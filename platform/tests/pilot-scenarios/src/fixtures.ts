/**
 * Shared fixtures for pilot scenario tests (MVP Section 7).
 *
 * Provides:
 * - NHS ODL schema (ParsedSchema)
 * - SPI OntologySchema for MemoryStorageProvider
 * - Action manifest YAML strings
 * - Mock CEL evaluator
 * - Factory functions for actors, contexts, and objects
 */

import type { ParsedSchema } from '@openfoundry/odl';
import type {
  OntologySchema,
  RequestContext,
  AuditRecord,
} from '@openfoundry/spi';

import type {
  ActionActor,
  ActionContext,
  SecurityLayer,
  CelEvaluator,
  CelEvalResult,
  AuditWriter,
  ActionEventPublisher,
  SideEffectHandler,
} from '@openfoundry/actions';

// ---------------------------------------------------------------------------
// NHS ODL Schema
// ---------------------------------------------------------------------------

export const NHS_SCHEMA: ParsedSchema = {
  objectTypes: [
    {
      kind: 'objectType',
      name: 'Patient',
      fields: [
        { name: 'id', type: { name: 'ID', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'primary' }] },
        { name: 'nhsNumber', type: { name: 'String', nonNull: false, isList: false, listElementNonNull: false }, directives: [{ kind: 'unique' }] },
        { name: 'name', type: { name: 'String', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'sensitive' }] },
        { name: 'dateOfBirth', type: { name: 'Date', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'sensitive' }] },
        { name: 'status', type: { name: 'String', nonNull: true, isList: false, listElementNonNull: false }, directives: [] },
        { name: 'clinicalNotes', type: { name: 'String', nonNull: false, isList: false, listElementNonNull: false }, directives: [{ kind: 'sensitive' }] },
        { name: 'currentWard', type: { name: 'String', nonNull: false, isList: false, listElementNonNull: false }, directives: [] },
      ],
      interfaces: [],
      directives: [{ kind: 'objectType' }],
    },
    {
      kind: 'objectType',
      name: 'Ward',
      fields: [
        { name: 'id', type: { name: 'ID', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'primary' }] },
        { name: 'name', type: { name: 'String', nonNull: true, isList: false, listElementNonNull: false }, directives: [] },
        { name: 'specialty', type: { name: 'String', nonNull: true, isList: false, listElementNonNull: false }, directives: [] },
        { name: 'capacity', type: { name: 'Int', nonNull: true, isList: false, listElementNonNull: false }, directives: [] },
      ],
      interfaces: [],
      directives: [{ kind: 'objectType' }],
    },
    {
      kind: 'objectType',
      name: 'Bed',
      fields: [
        { name: 'id', type: { name: 'ID', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'primary' }] },
        { name: 'number', type: { name: 'String', nonNull: true, isList: false, listElementNonNull: false }, directives: [] },
        { name: 'status', type: { name: 'String', nonNull: true, isList: false, listElementNonNull: false }, directives: [] },
      ],
      interfaces: [],
      directives: [{ kind: 'objectType' }],
    },
    {
      kind: 'objectType',
      name: 'Consultant',
      fields: [
        { name: 'id', type: { name: 'ID', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'primary' }] },
        { name: 'gmcNumber', type: { name: 'String', nonNull: false, isList: false, listElementNonNull: false }, directives: [{ kind: 'unique' }] },
        { name: 'name', type: { name: 'String', nonNull: true, isList: false, listElementNonNull: false }, directives: [] },
        { name: 'specialty', type: { name: 'String', nonNull: true, isList: false, listElementNonNull: false }, directives: [] },
      ],
      interfaces: [],
      directives: [{ kind: 'objectType' }],
    },
    {
      kind: 'objectType',
      name: 'DischargeRecord',
      fields: [
        { name: 'id', type: { name: 'ID', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'primary' }] },
        { name: 'patient', type: { name: 'String', nonNull: false, isList: false, listElementNonNull: false }, directives: [] },
        { name: 'ward', type: { name: 'String', nonNull: false, isList: false, listElementNonNull: false }, directives: [] },
        { name: 'destination', type: { name: 'String', nonNull: false, isList: false, listElementNonNull: false }, directives: [] },
        { name: 'dischargeDate', type: { name: 'String', nonNull: false, isList: false, listElementNonNull: false }, directives: [] },
        { name: 'notes', type: { name: 'String', nonNull: false, isList: false, listElementNonNull: false }, directives: [] },
      ],
      interfaces: [],
      directives: [{ kind: 'objectType' }],
    },
  ],
  linkTypes: [
    {
      kind: 'linkType',
      name: 'AdmittedTo',
      from: 'Patient',
      to: 'Ward',
      cardinality: 'MANY_TO_ONE',
      fields: [
        { name: 'id', type: { name: 'ID', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'primary' }] },
        { name: 'admissionDate', type: { name: 'DateTime', nonNull: true, isList: false, listElementNonNull: false }, directives: [] },
        { name: 'reason', type: { name: 'String', nonNull: false, isList: false, listElementNonNull: false }, directives: [] },
      ],
      directives: [{ kind: 'linkType', from: 'Patient', to: 'Ward', cardinality: 'MANY_TO_ONE' }],
    },
    {
      kind: 'linkType',
      name: 'OccupiesBed',
      from: 'Patient',
      to: 'Bed',
      cardinality: 'ONE_TO_ONE',
      fields: [
        { name: 'id', type: { name: 'ID', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'primary' }] },
        { name: 'assignedAt', type: { name: 'DateTime', nonNull: true, isList: false, listElementNonNull: false }, directives: [] },
      ],
      directives: [{ kind: 'linkType', from: 'Patient', to: 'Bed', cardinality: 'ONE_TO_ONE' }],
    },
    {
      kind: 'linkType',
      name: 'UnderCareOf',
      from: 'Patient',
      to: 'Consultant',
      cardinality: 'MANY_TO_ONE',
      fields: [
        { name: 'id', type: { name: 'ID', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'primary' }] },
        { name: 'assignedDate', type: { name: 'DateTime', nonNull: true, isList: false, listElementNonNull: false }, directives: [] },
        { name: 'role', type: { name: 'String', nonNull: true, isList: false, listElementNonNull: false }, directives: [] },
      ],
      directives: [{ kind: 'linkType', from: 'Patient', to: 'Consultant', cardinality: 'MANY_TO_ONE' }],
    },
    {
      kind: 'linkType',
      name: 'BedInWard',
      from: 'Bed',
      to: 'Ward',
      cardinality: 'MANY_TO_ONE',
      fields: [
        { name: 'id', type: { name: 'ID', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'primary' }] },
      ],
      directives: [{ kind: 'linkType', from: 'Bed', to: 'Ward', cardinality: 'MANY_TO_ONE' }],
    },
    {
      kind: 'linkType',
      name: 'DischargedPatient',
      from: 'DischargeRecord',
      to: 'Patient',
      cardinality: 'MANY_TO_ONE',
      fields: [
        { name: 'id', type: { name: 'ID', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'primary' }] },
      ],
      directives: [{ kind: 'linkType', from: 'DischargeRecord', to: 'Patient', cardinality: 'MANY_TO_ONE' }],
    },
  ],
  actionTypes: [
    {
      kind: 'actionType',
      name: 'AdmitPatient',
      fields: [
        { name: 'patient', type: { name: 'Patient', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'param' }], description: 'The patient to admit' },
        { name: 'ward', type: { name: 'Ward', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'param' }], description: 'Ward to admit to' },
        { name: 'bed', type: { name: 'Bed', nonNull: false, isList: false, listElementNonNull: false }, directives: [{ kind: 'param' }], description: 'Optional bed assignment' },
        { name: 'consultant', type: { name: 'Consultant', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'param' }], description: 'Consulting physician' },
        { name: 'reason', type: { name: 'String', nonNull: false, isList: false, listElementNonNull: false }, directives: [{ kind: 'param' }], description: 'Admission reason' },
      ],
      directives: [{ kind: 'actionType' }],
      description: 'Admit a patient to a ward',
    },
    {
      kind: 'actionType',
      name: 'DischargePatient',
      fields: [
        { name: 'patient', type: { name: 'Patient', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'param' }], description: 'The patient to discharge' },
        { name: 'destination', type: { name: 'String', nonNull: false, isList: false, listElementNonNull: false }, directives: [{ kind: 'param' }], description: 'Discharge destination' },
        { name: 'notes', type: { name: 'String', nonNull: false, isList: false, listElementNonNull: false }, directives: [{ kind: 'param' }], description: 'Discharge notes' },
      ],
      directives: [{ kind: 'actionType' }],
      description: 'Discharge a patient from the hospital',
    },
    {
      kind: 'actionType',
      name: 'TransferWard',
      fields: [
        { name: 'patient', type: { name: 'Patient', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'param' }], description: 'The patient to transfer' },
        { name: 'toWard', type: { name: 'Ward', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'param' }], description: 'Destination ward' },
        { name: 'toBed', type: { name: 'Bed', nonNull: false, isList: false, listElementNonNull: false }, directives: [{ kind: 'param' }], description: 'Optional bed in new ward' },
        { name: 'reason', type: { name: 'String', nonNull: false, isList: false, listElementNonNull: false }, directives: [{ kind: 'param' }], description: 'Transfer reason' },
      ],
      directives: [{ kind: 'actionType' }],
      description: 'Transfer a patient between wards',
    },
  ],
  enums: [],
  interfaces: [],
  scalars: [],
};

// ---------------------------------------------------------------------------
// SPI OntologySchema (for MemoryStorageProvider.applySchema)
// ---------------------------------------------------------------------------

export const SPI_SCHEMA: OntologySchema = {
  version: 1,
  objectTypes: [
    { name: 'Patient', properties: [
      { name: 'nhsNumber', type: 'String' },
      { name: 'name', type: 'String' },
      { name: 'dateOfBirth', type: 'String' },
      { name: 'status', type: 'String' },
      { name: 'clinicalNotes', type: 'String' },
      { name: 'currentWard', type: 'String' },
    ]},
    { name: 'Ward', properties: [
      { name: 'name', type: 'String' },
      { name: 'specialty', type: 'String' },
      { name: 'capacity', type: 'Int' },
    ]},
    { name: 'Bed', properties: [
      { name: 'number', type: 'String' },
      { name: 'status', type: 'String' },
    ]},
    { name: 'Consultant', properties: [
      { name: 'gmcNumber', type: 'String' },
      { name: 'name', type: 'String' },
      { name: 'specialty', type: 'String' },
    ]},
    { name: 'DischargeRecord', properties: [
      { name: 'patient', type: 'String' },
      { name: 'ward', type: 'String' },
      { name: 'destination', type: 'String' },
      { name: 'dischargeDate', type: 'String' },
      { name: 'notes', type: 'String' },
    ]},
  ],
  linkTypes: [
    { name: 'AdmittedTo', fromType: 'Patient', toType: 'Ward', cardinality: 'MANY_TO_MANY' },
    { name: 'OccupiesBed', fromType: 'Patient', toType: 'Bed', cardinality: 'ONE_TO_ONE' },
    { name: 'UnderCareOf', fromType: 'Patient', toType: 'Consultant', cardinality: 'MANY_TO_MANY' },
    { name: 'BedInWard', fromType: 'Bed', toType: 'Ward', cardinality: 'MANY_TO_MANY' },
    { name: 'DischargedPatient', fromType: 'DischargeRecord', toType: 'Patient', cardinality: 'MANY_TO_MANY' },
  ],
};

// ---------------------------------------------------------------------------
// Action Manifest YAML
// ---------------------------------------------------------------------------

export const ADMIT_PATIENT_YAML = `
action: AdmitPatient
version: 1
reversible: true

preconditions:
  - expr: "patient.status != 'ACTIVE' || patient.currentWard == null"
    error: "Patient is already admitted to a ward"
  - expr: "bed == null || bed.status == 'AVAILABLE'"
    error: "Selected bed is not available"

effects:
  - type: updateObject
    target: "patient"
    set:
      status: "ACTIVE"

  - type: createLink
    linkType: "AdmittedTo"
    from: "patient"
    to: "ward"
    properties:
      admissionDate: "now"
      reason: "params.reason"

  - type: createLink
    linkType: "UnderCareOf"
    from: "patient"
    to: "consultant"
    properties:
      assignedDate: "now"
      role: "'PRIMARY'"

  - type: updateObject
    target: "bed"
    condition: "bed != null"
    set:
      status: "OCCUPIED"

  - type: createLink
    linkType: "OccupiesBed"
    from: "patient"
    to: "bed"
    condition: "bed != null"
    properties:
      assignedAt: "now"

sideEffects:
  - name: emitAdmissionEvent
    type: event
    config:
      type: "nhs.acute.patient.admitted"

rollback:
  onSideEffectFailure: LOG_AND_CONTINUE
`;

export const DISCHARGE_PATIENT_YAML = `
action: DischargePatient
version: 1
reversible: true

preconditions:
  - expr: "patient.status == 'ACTIVE'"
    error: "Patient is not currently active"

effects:
  - type: updateObject
    target: "patient"
    set:
      status: "DISCHARGED"

  - type: deleteLink
    linkType: "AdmittedTo"
    filter:
      from: "patient"
      active: true
    expect: ONE

  - type: deleteLink
    linkType: "OccupiesBed"
    filter:
      from: "patient"
      active: true
    expect: ALL

  - type: deleteLink
    linkType: "UnderCareOf"
    filter:
      from: "patient"
      active: true
    expect: ALL

  - type: createObject
    objectType: "DischargeRecord"
    properties:
      patient: "patient"
      ward: "params.ward"
      destination: "params.destination"
      dischargeDate: "now"
      notes: "params.notes"

sideEffects:
  - name: emitDischargeEvent
    type: event
    config:
      type: "nhs.acute.patient.discharged"

rollback:
  onSideEffectFailure: LOG_AND_CONTINUE
`;

export const TRANSFER_WARD_YAML = `
action: TransferWard
version: 1
reversible: true

preconditions:
  - expr: "patient.status == 'ACTIVE'"
    error: "Patient is not currently active"

effects:
  - type: deleteLink
    linkType: "AdmittedTo"
    filter:
      from: "patient"
      active: true
    expect: ONE

  - type: deleteLink
    linkType: "OccupiesBed"
    filter:
      from: "patient"
      active: true
    expect: ALL

  - type: createLink
    linkType: "AdmittedTo"
    from: "patient"
    to: "toWard"
    properties:
      admissionDate: "now"
      reason: "params.reason"

  - type: updateObject
    target: "toBed"
    condition: "toBed != null"
    set:
      status: "OCCUPIED"

  - type: createLink
    linkType: "OccupiesBed"
    from: "patient"
    to: "toBed"
    condition: "toBed != null"
    properties:
      assignedAt: "now"

sideEffects:
  - name: emitTransferEvent
    type: event
    config:
      type: "nhs.acute.patient.transferred"

rollback:
  onSideEffectFailure: LOG_AND_CONTINUE
`;

// ---------------------------------------------------------------------------
// Mock CEL Evaluator
// ---------------------------------------------------------------------------

export function createMockCelEvaluator(): CelEvaluator {
  return {
    async evaluate(expression: string, variables: Record<string, unknown>): Promise<CelEvalResult> {
      try {
        const value = evalCelExpression(expression, variables);
        return { value };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

function evalCelExpression(expr: string, ctx: Record<string, unknown>): unknown {
  expr = expr.trim();

  // Handle OR (||)
  if (expr.includes('||')) {
    const parts = splitTopLevel(expr, '||');
    if (parts.length > 1) {
      return parts.some((p) => evalCelExpression(p, ctx) === true);
    }
  }

  // Handle AND (&&)
  if (expr.includes('&&')) {
    const parts = splitTopLevel(expr, '&&');
    if (parts.length > 1) {
      return parts.every((p) => evalCelExpression(p, ctx) === true);
    }
  }

  // Handle != comparison
  if (expr.includes('!=')) {
    const [left, right] = expr.split('!=').map((s) => s.trim());
    if (left && right) {
      return resolveValue(left, ctx) !== resolveValue(right, ctx);
    }
  }

  // Handle == comparison
  if (expr.includes('==')) {
    const [left, right] = expr.split('==').map((s) => s.trim());
    if (left && right) {
      return resolveValue(left, ctx) === resolveValue(right, ctx);
    }
  }

  // Handle hasRole() calls
  const hasRoleMatch = expr.match(/^actor\.hasRole\('(\w+)'\)$/);
  if (hasRoleMatch) {
    const role = hasRoleMatch[1]!;
    const actor = ctx['actor'] as { roles?: string[] } | undefined;
    return actor?.roles?.includes(role) ?? false;
  }

  return resolveValue(expr, ctx);
}

function resolveValue(expr: string, ctx: Record<string, unknown>): unknown {
  expr = expr.trim();
  if (expr.startsWith("'") && expr.endsWith("'")) return expr.slice(1, -1);
  if (expr === 'null') return null;
  if (expr === 'true') return true;
  if (expr === 'false') return false;

  const parts = expr.split('.');
  let current: unknown = ctx;
  for (const part of parts) {
    if (current === null || current === undefined) return null;
    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[part];
    } else {
      return null;
    }
  }
  return current ?? null;
}

function splitTopLevel(expr: string, op: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inQuote = false;
  let current = '';

  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i]!;
    if (ch === "'") {
      inQuote = !inQuote;
      current += ch;
    } else if (!inQuote && ch === '(') {
      depth++;
      current += ch;
    } else if (!inQuote && ch === ')') {
      depth--;
      current += ch;
    } else if (!inQuote && depth === 0 && expr.substring(i, i + op.length) === op) {
      parts.push(current);
      current = '';
      i += op.length - 1;
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

// ---------------------------------------------------------------------------
// Mock Security Layer (always allows)
// ---------------------------------------------------------------------------

export function createAllowAllSecurity(): SecurityLayer {
  return {
    async checkPermission() {
      return { allowed: true };
    },
  };
}

// ---------------------------------------------------------------------------
// Mock Side-Effect Handler (records events)
// ---------------------------------------------------------------------------

export interface EmittedEvent {
  name: string;
  type: string;
  config: Record<string, unknown>;
}

export function createMockSideEffectHandler(): SideEffectHandler & { events: EmittedEvent[] } {
  const events: EmittedEvent[] = [];
  return {
    events,
    async execute(name, type, config) {
      events.push({ name, type, config });
      return { success: true };
    },
  };
}

// ---------------------------------------------------------------------------
// Mock Audit Writer (records audit entries)
// ---------------------------------------------------------------------------

export function createMockAuditWriter(): AuditWriter & { records: AuditRecord[] } {
  const records: AuditRecord[] = [];
  return {
    records,
    async write(record: AuditRecord) {
      records.push(record);
    },
  };
}

// ---------------------------------------------------------------------------
// Mock Event Publisher (records published events)
// ---------------------------------------------------------------------------

export interface PublishedEvent {
  changeType: string;
  type: string;
  id: string;
  cause: { actionType: string; actionId: string; actor: string };
}

export function createMockEventPublisher(): ActionEventPublisher & { events: PublishedEvent[] } {
  const events: PublishedEvent[] = [];
  return {
    events,
    async publishObjectChange(changeType, objectType, objectId, _before, _after, cause) {
      events.push({ changeType, type: objectType, id: objectId, cause });
    },
    async publishLinkChange(changeType, linkType, linkId, _fromId, _toId, cause) {
      events.push({ changeType, type: linkType, id: linkId, cause });
    },
  };
}

// ---------------------------------------------------------------------------
// Request Context Factory
// ---------------------------------------------------------------------------

export function createRequestContext(tenantId = 'nhs-trust-1', traceId?: string): RequestContext {
  return {
    tenantId,
    actorId: 'system',
    traceId: traceId ?? `trace-${Date.now()}`,
  };
}

// ---------------------------------------------------------------------------
// Actor Factories
// ---------------------------------------------------------------------------

export function createClinicianActor(id = 'dr-smith', roles: string[] = ['clinician']): ActionActor {
  return { id, type: 'user', roles };
}

export function createNurseActor(id = 'nurse-alice', roles: string[] = ['nurse']): ActionActor {
  return { id, type: 'user', roles };
}

export function createReceptionistActor(id = 'receptionist-bob', roles: string[] = ['receptionist']): ActionActor {
  return { id, type: 'user', roles };
}

export function createSystemActor(): ActionActor {
  return { id: 'system', type: 'system', roles: ['system'] };
}

// ---------------------------------------------------------------------------
// Action Context Factory
// ---------------------------------------------------------------------------

export function createActionContext(reqCtx: RequestContext): ActionContext {
  return { requestContext: reqCtx };
}

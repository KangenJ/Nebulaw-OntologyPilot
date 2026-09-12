/**
 * Tests for the action manifest parser.
 *
 * Uses all 3 NHS action manifests from MVP Section 4.3:
 * - AdmitPatient
 * - DischargePatient
 * - TransferWard
 */

import { describe, it, expect } from 'vitest';

import { parseActionManifest } from '../index.js';
import type { ParsedSchema } from '@openfoundry/odl';

// ---------------------------------------------------------------------------
// NHS action manifest YAML fixtures
// ---------------------------------------------------------------------------

const ADMIT_PATIENT_YAML = `
action: AdmitPatient
version: 1
reversible: false

preconditions:
  - expr: "patient.status != 'ACTIVE' || patient.currentWard == null"
    error: "Patient is already admitted to a ward"
  - expr: "bed == null || bed.status == 'AVAILABLE'"
    error: "Selected bed is not available"
  - expr: "actor.hasRole('clinician') || actor.hasRole('nurse_in_charge') || actor.hasRole('admin')"
    error: "Insufficient role for admission"

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
      data:
        patientId: "patient.id"
        wardName: "ward.name"
        consultantName: "consultant.name"

rollback:
  onSideEffectFailure: LOG_AND_CONTINUE
`;

const DISCHARGE_PATIENT_YAML = `
action: DischargePatient
version: 1
reversible: false

preconditions:
  - expr: "patient.status == 'ACTIVE'"
    error: "Patient is not currently active"
  - expr: "patient.currentWard != null"
    error: "Patient is not currently admitted"
  - expr: "actor.hasRole('clinician') || actor.hasRole('nurse_in_charge')"
    error: "Only clinicians or nurses in charge can discharge patients"

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
      ward: "patient.currentWard"
      destination: "params.destination"
      dischargeDate: "now"
      notes: "params.notes"

sideEffects:
  - name: emitDischargeEvent
    type: event
    config:
      type: "nhs.acute.patient.discharged"
      data:
        patientId: "patient.id"
        ward: "patient.currentWard.name"
        destination: "params.destination"

rollback:
  onSideEffectFailure: LOG_AND_CONTINUE
`;

const TRANSFER_WARD_YAML = `
action: TransferWard
version: 1
reversible: false

preconditions:
  - expr: "patient.status == 'ACTIVE'"
    error: "Patient is not currently active"
  - expr: "patient.currentWard != null"
    error: "Patient is not currently admitted"
  - expr: "patient.currentWard.id != toWard.id"
    error: "Patient is already on the destination ward"
  - expr: "toBed == null || toBed.status == 'AVAILABLE'"
    error: "Selected bed is not available"
  - expr: "actor.hasRole('clinician') || actor.hasRole('nurse_in_charge')"
    error: "Insufficient role for ward transfer"

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
      data:
        patientId: "patient.id"
        fromWard: "patient.currentWard.name"
        toWard: "toWard.name"

rollback:
  onSideEffectFailure: LOG_AND_CONTINUE
`;

// ---------------------------------------------------------------------------
// Minimal ODL schema for cross-reference testing
// ---------------------------------------------------------------------------

const NHS_SCHEMA: ParsedSchema = {
  objectTypes: [
    {
      kind: 'objectType',
      name: 'Patient',
      fields: [
        { name: 'id', type: { name: 'ID', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'primary' }] },
        { name: 'status', type: { name: 'String', nonNull: true, isList: false, listElementNonNull: false }, directives: [] },
        { name: 'name', type: { name: 'String', nonNull: true, isList: false, listElementNonNull: false }, directives: [] },
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
      ],
      interfaces: [],
      directives: [{ kind: 'objectType' }],
    },
    {
      kind: 'objectType',
      name: 'Bed',
      fields: [
        { name: 'id', type: { name: 'ID', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'primary' }] },
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
        { name: 'name', type: { name: 'String', nonNull: true, isList: false, listElementNonNull: false }, directives: [] },
      ],
      interfaces: [],
      directives: [{ kind: 'objectType' }],
    },
    {
      kind: 'objectType',
      name: 'DischargeRecord',
      fields: [
        { name: 'id', type: { name: 'ID', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'primary' }] },
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
      ],
      directives: [{ kind: 'linkType', from: 'Patient', to: 'Ward', cardinality: 'MANY_TO_ONE' }],
    },
    {
      kind: 'linkType',
      name: 'UnderCareOf',
      from: 'Patient',
      to: 'Consultant',
      cardinality: 'MANY_TO_ONE',
      fields: [
        { name: 'id', type: { name: 'ID', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'primary' }] },
      ],
      directives: [{ kind: 'linkType', from: 'Patient', to: 'Consultant', cardinality: 'MANY_TO_ONE' }],
    },
    {
      kind: 'linkType',
      name: 'OccupiesBed',
      from: 'Patient',
      to: 'Bed',
      cardinality: 'ONE_TO_ONE',
      fields: [
        { name: 'id', type: { name: 'ID', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'primary' }] },
      ],
      directives: [{ kind: 'linkType', from: 'Patient', to: 'Bed', cardinality: 'ONE_TO_ONE' }],
    },
  ],
  actionTypes: [
    {
      kind: 'actionType',
      name: 'AdmitPatient',
      fields: [
        { name: 'patient', type: { name: 'Patient', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'param' }] },
        { name: 'ward', type: { name: 'Ward', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'param' }] },
        { name: 'consultant', type: { name: 'Consultant', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'param' }] },
        { name: 'bed', type: { name: 'Bed', nonNull: false, isList: false, listElementNonNull: false }, directives: [{ kind: 'param' }] },
        { name: 'reason', type: { name: 'String', nonNull: false, isList: false, listElementNonNull: false }, directives: [{ kind: 'param' }] },
      ],
      directives: [{ kind: 'actionType' }],
    },
    {
      kind: 'actionType',
      name: 'DischargePatient',
      fields: [
        { name: 'patient', type: { name: 'Patient', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'param' }] },
        { name: 'destination', type: { name: 'String', nonNull: false, isList: false, listElementNonNull: false }, directives: [{ kind: 'param' }] },
        { name: 'notes', type: { name: 'String', nonNull: false, isList: false, listElementNonNull: false }, directives: [{ kind: 'param' }] },
      ],
      directives: [{ kind: 'actionType' }],
    },
    {
      kind: 'actionType',
      name: 'TransferWard',
      fields: [
        { name: 'patient', type: { name: 'Patient', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'param' }] },
        { name: 'toWard', type: { name: 'Ward', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'param' }] },
        { name: 'toBed', type: { name: 'Bed', nonNull: false, isList: false, listElementNonNull: false }, directives: [{ kind: 'param' }] },
        { name: 'reason', type: { name: 'String', nonNull: false, isList: false, listElementNonNull: false }, directives: [{ kind: 'param' }] },
      ],
      directives: [{ kind: 'actionType' }],
    },
  ],
  enums: [],
  interfaces: [],
  scalars: [],
};

// ---------------------------------------------------------------------------
// Tests: NHS manifest parsing (structural only)
// ---------------------------------------------------------------------------

describe('parseActionManifest', () => {
  describe('AdmitPatient manifest', () => {
    it('parses without errors', () => {
      const result = parseActionManifest(ADMIT_PATIENT_YAML);
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
      expect(result.manifest).toBeDefined();
    });

    it('has correct top-level fields', () => {
      const { manifest } = parseActionManifest(ADMIT_PATIENT_YAML);
      expect(manifest!.action).toBe('AdmitPatient');
      expect(manifest!.version).toBe(1);
      expect(manifest!.reversible).toBe(false);
    });

    it('parses preconditions', () => {
      const { manifest } = parseActionManifest(ADMIT_PATIENT_YAML);
      expect(manifest!.preconditions).toHaveLength(3);
      expect(manifest!.preconditions[0]!.expr).toBe(
        "patient.status != 'ACTIVE' || patient.currentWard == null",
      );
      expect(manifest!.preconditions[0]!.error).toBe(
        'Patient is already admitted to a ward',
      );
    });

    it('parses effects with correct types', () => {
      const { manifest } = parseActionManifest(ADMIT_PATIENT_YAML);
      expect(manifest!.effects).toHaveLength(5);

      // First effect: updateObject
      expect(manifest!.effects[0]!.type).toBe('updateObject');
      const update = manifest!.effects[0]! as { type: 'updateObject'; target: string; set: Record<string, string> };
      expect(update.target).toBe('patient');
      expect(update.set['status']).toBe('ACTIVE');

      // Second effect: createLink
      expect(manifest!.effects[1]!.type).toBe('createLink');
      const link = manifest!.effects[1]! as { type: 'createLink'; linkType: string; from: string; to: string };
      expect(link.linkType).toBe('AdmittedTo');
      expect(link.from).toBe('patient');
      expect(link.to).toBe('ward');

      // Fourth effect: updateObject with condition
      expect(manifest!.effects[3]!.type).toBe('updateObject');
      const condUpdate = manifest!.effects[3]! as { type: 'updateObject'; condition?: string };
      expect(condUpdate.condition).toBe('bed != null');

      // Fifth effect: createLink with condition
      expect(manifest!.effects[4]!.type).toBe('createLink');
      const condLink = manifest!.effects[4]! as { type: 'createLink'; condition?: string };
      expect(condLink.condition).toBe('bed != null');
    });

    it('parses side effects', () => {
      const { manifest } = parseActionManifest(ADMIT_PATIENT_YAML);
      expect(manifest!.sideEffects).toHaveLength(1);
      expect(manifest!.sideEffects[0]!.name).toBe('emitAdmissionEvent');
      expect(manifest!.sideEffects[0]!.type).toBe('event');
    });

    it('parses rollback config', () => {
      const { manifest } = parseActionManifest(ADMIT_PATIENT_YAML);
      expect(manifest!.rollback).toBeDefined();
      expect(manifest!.rollback!.onSideEffectFailure).toBe('LOG_AND_CONTINUE');
    });
  });

  describe('DischargePatient manifest', () => {
    it('parses without errors', () => {
      const result = parseActionManifest(DISCHARGE_PATIENT_YAML);
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
      expect(result.manifest).toBeDefined();
    });

    it('has correct top-level fields', () => {
      const { manifest } = parseActionManifest(DISCHARGE_PATIENT_YAML);
      expect(manifest!.action).toBe('DischargePatient');
      expect(manifest!.version).toBe(1);
      expect(manifest!.reversible).toBe(false);
    });

    it('parses deleteLink effects with filter and expect', () => {
      const { manifest } = parseActionManifest(DISCHARGE_PATIENT_YAML);

      // effects[1]: deleteLink AdmittedTo
      const delAdmitted = manifest!.effects[1]!;
      expect(delAdmitted.type).toBe('deleteLink');
      const del = delAdmitted as { type: 'deleteLink'; linkType: string; filter: { from?: string; active?: boolean }; expect?: string };
      expect(del.linkType).toBe('AdmittedTo');
      expect(del.filter.from).toBe('patient');
      expect(del.filter.active).toBe(true);
      expect(del.expect).toBe('ONE');

      // effects[2]: deleteLink OccupiesBed, expect ALL
      const delBed = manifest!.effects[2]! as { type: 'deleteLink'; expect?: string };
      expect(delBed.expect).toBe('ALL');
    });

    it('parses createObject effect', () => {
      const { manifest } = parseActionManifest(DISCHARGE_PATIENT_YAML);

      // Last effect: createObject DischargeRecord
      const create = manifest!.effects[4]!;
      expect(create.type).toBe('createObject');
      const co = create as { type: 'createObject'; objectType: string; properties: Record<string, string> };
      expect(co.objectType).toBe('DischargeRecord');
      expect(co.properties['patient']).toBe('patient');
      expect(co.properties['destination']).toBe('params.destination');
    });
  });

  describe('TransferWard manifest', () => {
    it('parses without errors', () => {
      const result = parseActionManifest(TRANSFER_WARD_YAML);
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
      expect(result.manifest).toBeDefined();
    });

    it('has correct top-level fields', () => {
      const { manifest } = parseActionManifest(TRANSFER_WARD_YAML);
      expect(manifest!.action).toBe('TransferWard');
      expect(manifest!.version).toBe(1);
    });

    it('parses all 5 effects in correct order', () => {
      const { manifest } = parseActionManifest(TRANSFER_WARD_YAML);
      expect(manifest!.effects).toHaveLength(5);
      expect(manifest!.effects.map(e => e.type)).toEqual([
        'deleteLink',
        'deleteLink',
        'createLink',
        'updateObject',
        'createLink',
      ]);
    });

    it('has 5 preconditions', () => {
      const { manifest } = parseActionManifest(TRANSFER_WARD_YAML);
      expect(manifest!.preconditions).toHaveLength(5);
    });
  });

  // -----------------------------------------------------------------------
  // Structural validation errors
  // -----------------------------------------------------------------------

  describe('structural validation errors', () => {
    it('rejects invalid YAML', () => {
      const result = parseActionManifest('{{invalid yaml');
      expect(result.valid).toBe(false);
      expect(result.errors[0]!.code).toBe('YAML_PARSE_ERROR');
    });

    it('rejects non-object documents', () => {
      const result = parseActionManifest('- just\n- a\n- list');
      expect(result.valid).toBe(false);
      expect(result.errors[0]!.code).toBe('INVALID_DOCUMENT');
    });

    it('rejects manifest missing action field', () => {
      const yaml = `
version: 1
effects: []
`;
      const result = parseActionManifest(yaml);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'MISSING_FIELD' && e.path === 'action')).toBe(true);
    });

    it('rejects manifest missing version field', () => {
      const yaml = `
action: TestAction
effects: []
`;
      const result = parseActionManifest(yaml);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'MISSING_FIELD' && e.path === 'version')).toBe(true);
    });

    it('rejects non-integer version', () => {
      const yaml = `
action: TestAction
version: "one"
`;
      const result = parseActionManifest(yaml);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'INVALID_TYPE' && e.path === 'version')).toBe(true);
    });

    it('rejects invalid effect type', () => {
      const yaml = `
action: TestAction
version: 1
effects:
  - type: destroyEverything
    target: "world"
`;
      const result = parseActionManifest(yaml);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'INVALID_EFFECT_TYPE')).toBe(true);
    });

    it('rejects updateObject without target', () => {
      const yaml = `
action: TestAction
version: 1
effects:
  - type: updateObject
    set:
      status: "ACTIVE"
`;
      const result = parseActionManifest(yaml);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e =>
        e.code === 'MISSING_FIELD' && e.path === 'effects[0].target',
      )).toBe(true);
    });

    it('rejects createLink without required fields', () => {
      const yaml = `
action: TestAction
version: 1
effects:
  - type: createLink
    linkType: "SomeLink"
`;
      const result = parseActionManifest(yaml);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.path === 'effects[0].from')).toBe(true);
      expect(result.errors.some(e => e.path === 'effects[0].to')).toBe(true);
    });

    it('rejects deleteLink without linkType', () => {
      const yaml = `
action: TestAction
version: 1
effects:
  - type: deleteLink
    filter:
      from: "patient"
`;
      const result = parseActionManifest(yaml);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.path === 'effects[0].linkType')).toBe(true);
    });

    it('rejects invalid expect value on deleteLink', () => {
      const yaml = `
action: TestAction
version: 1
effects:
  - type: deleteLink
    linkType: "SomeLink"
    expect: MANY
`;
      const result = parseActionManifest(yaml);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'INVALID_VALUE' && e.path === 'effects[0].expect')).toBe(true);
    });

    it('rejects createObject without objectType', () => {
      const yaml = `
action: TestAction
version: 1
effects:
  - type: createObject
    properties:
      name: "test"
`;
      const result = parseActionManifest(yaml);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.path === 'effects[0].objectType')).toBe(true);
    });

    it('rejects invalid rollback policy', () => {
      const yaml = `
action: TestAction
version: 1
rollback:
  onSideEffectFailure: PANIC
`;
      const result = parseActionManifest(yaml);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'INVALID_VALUE' && e.path === 'rollback.onSideEffectFailure')).toBe(true);
    });

    it('rejects precondition without expr', () => {
      const yaml = `
action: TestAction
version: 1
preconditions:
  - error: "Some error"
`;
      const result = parseActionManifest(yaml);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.path === 'preconditions[0].expr')).toBe(true);
    });

    it('rejects side effect without name', () => {
      const yaml = `
action: TestAction
version: 1
sideEffects:
  - type: event
    config:
      type: "some.event"
`;
      const result = parseActionManifest(yaml);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.path === 'sideEffects[0].name')).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Effect type discrimination
  // -----------------------------------------------------------------------

  describe('effect type discrimination', () => {
    it('discriminates all four effect types', () => {
      const yaml = `
action: TestAction
version: 1
effects:
  - type: updateObject
    target: "patient"
    set:
      status: "ACTIVE"
  - type: createLink
    linkType: "Link1"
    from: "a"
    to: "b"
  - type: deleteLink
    linkType: "Link2"
  - type: createObject
    objectType: "Record"
    properties:
      name: "test"
`;
      const result = parseActionManifest(yaml);
      expect(result.valid).toBe(true);
      expect(result.manifest!.effects).toHaveLength(4);

      const [e0, e1, e2, e3] = result.manifest!.effects;
      expect(e0!.type).toBe('updateObject');
      expect(e1!.type).toBe('createLink');
      expect(e2!.type).toBe('deleteLink');
      expect(e3!.type).toBe('createObject');

      // Type narrowing works
      if (e0!.type === 'updateObject') {
        expect(e0!.target).toBe('patient');
        expect(e0!.set['status']).toBe('ACTIVE');
      }
      if (e1!.type === 'createLink') {
        expect(e1!.linkType).toBe('Link1');
      }
      if (e2!.type === 'deleteLink') {
        expect(e2!.linkType).toBe('Link2');
      }
      if (e3!.type === 'createObject') {
        expect(e3!.objectType).toBe('Record');
      }
    });
  });

  // -----------------------------------------------------------------------
  // Schema cross-reference validation
  // -----------------------------------------------------------------------

  describe('schema cross-reference', () => {
    it('AdmitPatient passes cross-reference validation', () => {
      const result = parseActionManifest(ADMIT_PATIENT_YAML, NHS_SCHEMA);
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    });

    it('DischargePatient passes cross-reference validation', () => {
      const result = parseActionManifest(DISCHARGE_PATIENT_YAML, NHS_SCHEMA);
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    });

    it('TransferWard passes cross-reference validation', () => {
      const result = parseActionManifest(TRANSFER_WARD_YAML, NHS_SCHEMA);
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    });

    it('rejects unknown action type', () => {
      const yaml = `
action: UnknownAction
version: 1
`;
      const result = parseActionManifest(yaml, NHS_SCHEMA);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'UNKNOWN_ACTION_TYPE')).toBe(true);
    });

    it('rejects unknown link type in effect', () => {
      const yaml = `
action: AdmitPatient
version: 1
effects:
  - type: createLink
    linkType: "NonExistentLink"
    from: "patient"
    to: "ward"
`;
      const result = parseActionManifest(yaml, NHS_SCHEMA);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'UNKNOWN_LINK_TYPE')).toBe(true);
    });

    it('rejects unknown object type in createObject', () => {
      const yaml = `
action: DischargePatient
version: 1
effects:
  - type: createObject
    objectType: "NonExistentType"
    properties:
      name: "test"
`;
      const result = parseActionManifest(yaml, NHS_SCHEMA);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'UNKNOWN_OBJECT_TYPE')).toBe(true);
    });

    it('warns on unknown param references in effects', () => {
      const yaml = `
action: AdmitPatient
version: 1
effects:
  - type: updateObject
    target: "unknownParam"
    set:
      status: "ACTIVE"
`;
      const result = parseActionManifest(yaml, NHS_SCHEMA);
      // This is a warning, not an error (the manifest is still structurally valid)
      expect(result.warnings.some(w => w.code === 'UNKNOWN_PARAM_REF')).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Defaults and optional fields
  // -----------------------------------------------------------------------

  describe('defaults and optional fields', () => {
    it('defaults reversible to false', () => {
      const yaml = `
action: TestAction
version: 1
`;
      const result = parseActionManifest(yaml);
      expect(result.valid).toBe(true);
      expect(result.manifest!.reversible).toBe(false);
    });

    it('allows empty preconditions', () => {
      const yaml = `
action: TestAction
version: 1
`;
      const result = parseActionManifest(yaml);
      expect(result.manifest!.preconditions).toEqual([]);
    });

    it('allows empty effects', () => {
      const yaml = `
action: TestAction
version: 1
`;
      const result = parseActionManifest(yaml);
      expect(result.manifest!.effects).toEqual([]);
    });

    it('allows empty side effects', () => {
      const yaml = `
action: TestAction
version: 1
`;
      const result = parseActionManifest(yaml);
      expect(result.manifest!.sideEffects).toEqual([]);
    });

    it('allows omitted rollback', () => {
      const yaml = `
action: TestAction
version: 1
`;
      const result = parseActionManifest(yaml);
      expect(result.manifest!.rollback).toBeUndefined();
    });
  });
});

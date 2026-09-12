/**
 * AI Tool Registry scenario tests (MVP Section 7.9).
 *
 * Tests:
 *   - availableTools(filter: { kind: ACTION }) returns 3 ToolDescriptors
 *   - Each has a valid JSON Schema in parameters
 *   - Each has requiredPermissions listed
 *   - Each has dryRunSupported == true
 *
 * Runs against the in-memory stack (no Docker required).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry, parseActionManifest } from '@openfoundry/actions';
import type { ActionManifest } from '@openfoundry/actions';

import {
  NHS_SCHEMA,
  ADMIT_PATIENT_YAML,
  DISCHARGE_PATIENT_YAML,
  TRANSFER_WARD_YAML,
} from './fixtures.js';

// ---------------------------------------------------------------------------
// Parse manifests (extract .manifest from ManifestValidationResult)
// ---------------------------------------------------------------------------

function mustParseManifest(yaml: string): ActionManifest {
  const result = parseActionManifest(yaml);
  if (!result.valid || !result.manifest) {
    throw new Error(`Failed to parse manifest: ${result.errors.map(e => e.message).join(', ')}`);
  }
  return result.manifest;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let registry: ToolRegistry;

beforeEach(() => {
  const manifests = new Map<string, ActionManifest>();
  manifests.set('AdmitPatient', mustParseManifest(ADMIT_PATIENT_YAML));
  manifests.set('DischargePatient', mustParseManifest(DISCHARGE_PATIENT_YAML));
  manifests.set('TransferWard', mustParseManifest(TRANSFER_WARD_YAML));

  registry = new ToolRegistry({
    schema: NHS_SCHEMA,
    manifests,
  });
});

// ---------------------------------------------------------------------------
// 7.9 -- AI Tool Registry
// ---------------------------------------------------------------------------

describe('Section 7.9: AI Tool Registry', () => {
  describe('WHEN client queries availableTools(filter: { kind: ACTION })', () => {
    it('THEN 3 ToolDescriptors are returned (AdmitPatient, DischargePatient, TransferWard)', () => {
      const tools = registry.availableTools({ kind: 'ACTION' });

      expect(tools.length).toBe(3);

      const names = tools.map(t => t.name).sort();
      expect(names).toEqual(['AdmitPatient', 'DischargePatient', 'TransferWard']);
    });

    it('THEN each has kind == ACTION', () => {
      const tools = registry.availableTools({ kind: 'ACTION' });

      for (const tool of tools) {
        expect(tool.kind).toBe('ACTION');
      }
    });

    it('THEN each has a valid JSON Schema in parameters', () => {
      const tools = registry.availableTools({ kind: 'ACTION' });

      for (const tool of tools) {
        expect(tool.parameters).toBeDefined();
        expect(tool.parameters.type).toBe('object');
        expect(tool.parameters.properties).toBeDefined();
        expect(typeof tool.parameters.properties).toBe('object');

        // At least one property defined
        const propCount = Object.keys(tool.parameters.properties!).length;
        expect(propCount).toBeGreaterThan(0);
      }

      // AdmitPatient should have patient, ward, bed, consultant, reason params
      const admit = tools.find(t => t.name === 'AdmitPatient')!;
      expect(admit.parameters.properties!['patient']).toBeDefined();
      expect(admit.parameters.properties!['ward']).toBeDefined();
      expect(admit.parameters.properties!['consultant']).toBeDefined();

      // Required params should be listed
      expect(admit.parameters.required).toBeDefined();
      expect(admit.parameters.required).toContain('patient');
      expect(admit.parameters.required).toContain('ward');
      expect(admit.parameters.required).toContain('consultant');

      // DischargePatient should have patient param
      const discharge = tools.find(t => t.name === 'DischargePatient')!;
      expect(discharge.parameters.properties!['patient']).toBeDefined();
      expect(discharge.parameters.required).toContain('patient');

      // TransferWard should have patient, toWard params
      const transfer = tools.find(t => t.name === 'TransferWard')!;
      expect(transfer.parameters.properties!['patient']).toBeDefined();
      expect(transfer.parameters.properties!['toWard']).toBeDefined();
      expect(transfer.parameters.required).toContain('patient');
      expect(transfer.parameters.required).toContain('toWard');
    });

    it('THEN each has requiredPermissions listed', () => {
      const tools = registry.availableTools({ kind: 'ACTION' });

      for (const tool of tools) {
        expect(tool.requiredPermissions).toBeDefined();
        expect(Array.isArray(tool.requiredPermissions)).toBe(true);
        expect(tool.requiredPermissions.length).toBeGreaterThan(0);

        // Should include the action:execute permission
        const hasExecutePerm = tool.requiredPermissions.some(
          p => p.startsWith('action:') && p.endsWith(':execute'),
        );
        expect(hasExecutePerm).toBe(true);
      }
    });

    it('THEN each has dryRunSupported == true', () => {
      const tools = registry.availableTools({ kind: 'ACTION' });

      for (const tool of tools) {
        expect(tool.dryRunSupported).toBe(true);
      }
    });

    it('THEN each has a returnType JSON Schema', () => {
      const tools = registry.availableTools({ kind: 'ACTION' });

      for (const tool of tools) {
        expect(tool.returnType).toBeDefined();
        expect(tool.returnType.type).toBe('object');
        expect(tool.returnType.properties).toBeDefined();
        expect(tool.returnType.properties!['success']).toBeDefined();
        expect(tool.returnType.properties!['actionId']).toBeDefined();
      }
    });

    it('THEN each has a description', () => {
      const tools = registry.availableTools({ kind: 'ACTION' });

      for (const tool of tools) {
        expect(tool.description).toBeDefined();
        expect(tool.description.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Filtering', () => {
    it('availableTools with no filter returns all 3 actions', () => {
      const tools = registry.availableTools();
      expect(tools.length).toBe(3);
    });

    it('availableTools with namePattern filter narrows results', () => {
      const tools = registry.availableTools({ namePattern: 'Discharge' });
      expect(tools.length).toBe(1);
      expect(tools[0]!.name).toBe('DischargePatient');
    });
  });
});

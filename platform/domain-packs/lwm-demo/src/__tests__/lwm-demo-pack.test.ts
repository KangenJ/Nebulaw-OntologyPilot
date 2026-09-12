import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { parseActionManifest } from '@openfoundry/actions';
import { parseOdl, validateSchema } from '@openfoundry/odl';

const here = dirname(fileURLToPath(import.meta.url));
const packRoot = resolve(here, '..', '..');

const schemaFiles = ['enums.odl', 'objects.odl', 'links.odl', 'actions.odl'];
const actionFiles = [
  'approve-transition.yaml',
  'reject-transition.yaml',
  'request-evidence.yaml',
  'complete-investigation-task.yaml',
  'promote-model.yaml',
  'rollback-model.yaml',
  'hold-model.yaml',
];

function read(relativePath: string): string {
  return readFileSync(resolve(packRoot, relativePath), 'utf8');
}

function combinedSchema(): string {
  const sources = schemaFiles.map((file) => read(`schema/${file}`));
  return [
    sources[0]!,
    ...sources.slice(1).map((source) =>
      source.replace(/^extend schema @namespace\([^)]+\)\s*/m, ''),
    ),
  ].join('\n\n');
}

describe('LWM demo domain pack', () => {
  it('declares the expected manifest surface', () => {
    const pack = parseYaml(read('pack.yaml')) as Record<string, unknown>;
    expect(pack['name']).toBe('lwm-demo');
    expect(pack['namespace']).toBe('lwm.demo');
    expect(pack['capabilities']).toBeUndefined();
    expect(pack['schema']).toEqual(schemaFiles.map((file) => `schema/${file}`));
    expect(pack['actions']).toEqual(actionFiles.map((file) => `actions/${file}`));
    expect(pack['permissions']).toEqual(['permissions/lwm-roles.fga']);

    const provides = pack['provides'] as Record<string, number>;
    expect(provides).toMatchObject({ objectTypes: 8, linkTypes: 7, actionTypes: 7 });
  });

  it('parses and validates the combined ontology', () => {
    const schema = parseOdl(combinedSchema());
    const validation = validateSchema(schema);
    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);

    expect(schema.objectTypes.map((type) => type.name).sort()).toEqual([
      'FeedbackEvent',
      'HumanReview',
      'InvestigationTask',
      'Matter',
      'ModelVersion',
      'Observation',
      'RuleVersion',
      'TransitionProposal',
    ]);
    expect(schema.linkTypes).toHaveLength(7);
    expect(schema.actionTypes).toHaveLength(7);
  });

  it.each(schemaFiles)('%s parses independently', (file) => {
    expect(parseOdl(read(`schema/${file}`))).toBeDefined();
  });

  it.each(actionFiles)('%s is a valid governed action', (file) => {
    const result = parseActionManifest(read(`actions/${file}`));
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.manifest).toBeDefined();
  });

  it('keeps state changes behind deterministic approval gates', () => {
    const approval = parseActionManifest(read('actions/approve-transition.yaml')).manifest!;
    expect(approval.preconditions.map((condition) => condition.expr)).toEqual(
      expect.arrayContaining([
        "proposal.status == 'PENDING'",
        "proposal.gateStatus == 'PASS'",
        'matter.currentState == proposal.fromState',
      ]),
    );
    expect(approval.effects.map((effect) => effect.type)).toEqual([
      'updateObject',
      'updateObject',
      'createObject',
      'createLink',
      'createObject',
      'createLink',
      'createLink',
    ]);
  });

  it('requires offline quality thresholds and an explicit owner for promotion', () => {
    const promotion = parseActionManifest(read('actions/promote-model.yaml')).manifest!;
    const expressions = promotion.preconditions.map((condition) => condition.expr);
    expect(expressions).toContain("candidate.stage == 'CANDIDATE'");
    expect(expressions).toContain('candidate.validationScore >= 0.85');
    expect(expressions).toContain('candidate.calibrationError <= 0.12');
    expect(expressions.at(-1)).toContain('model_owner');
  });

  it('defines viewer and action relations for every governed target', () => {
    const fga = read('permissions/lwm-roles.fga');
    for (const type of [
      'matter', 'rule_version', 'observation', 'transition_proposal',
      'human_review', 'investigation_task', 'feedback_event', 'model_version',
    ]) {
      expect(fga).toContain(`type ${type}`);
    }
    expect(fga.match(/define viewer:/g)).toHaveLength(8);
    expect(fga).toContain('define can_approve:');
    expect(fga).toContain('define can_complete:');
    expect(fga).toContain('define can_promote:');
    expect(fga).toContain('define can_rollback:');
  });

  it('has explicit field permissions for every object containing sensitive data', () => {
    const fieldPermissions = parseYaml(read('permissions/field-permissions.yaml')) as Array<{
      objectType: string;
      fieldsByRelation: Record<string, string[]>;
    }>;
    expect(fieldPermissions.map((entry) => entry.objectType).sort()).toEqual([
      'FeedbackEvent',
      'HumanReview',
      'InvestigationTask',
      'Matter',
      'Observation',
      'TransitionProposal',
    ]);
    for (const entry of fieldPermissions) {
      expect(Object.keys(entry.fieldsByRelation).length).toBeGreaterThan(0);
    }
  });

  it('ships only clearly synthetic seed data in one workspace', () => {
    const seed = parseYaml(read('seeds/demo-data.yaml')) as {
      objects: Array<{ type: string; fields: Record<string, unknown> }>;
      links: Array<{ type: string; from: string; to: string }>;
    };
    expect(seed.objects.length).toBeGreaterThanOrEqual(15);
    expect(seed.links.length).toBeGreaterThanOrEqual(10);
    expect(seed.objects.every((object) => object.fields['workspaceKey'] === 'lwm-demo')).toBe(true);
    expect(JSON.stringify(seed)).toContain('Synthetic');
  });
});

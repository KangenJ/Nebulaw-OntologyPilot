/**
 * Tests for domain pack schema loading.
 *
 * Validates that loadDomainPacks correctly:
 * - Discovers packs from the filesystem
 * - Parses ODL files and produces a merged ParsedSchema
 * - Converts to OntologySchema for the SPI layer
 * - Extracts indexes from directives
 * - Loads packs from extra directories (multi-directory support)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadDomainPacks } from '../schema-loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOMAIN_PACKS_DIR = resolve(__dirname, '..', '..', '..', '..', 'domain-packs');

describe('loadDomainPacks', () => {
  it('loads core pack alone', async () => {
    const { parsed, spiSchema, packs } = await loadDomainPacks(DOMAIN_PACKS_DIR, ['core']);

    expect(packs).toHaveLength(1);
    expect(packs[0]!.name).toBe('core');

    // Core provides 6 custom scalars and interfaces
    expect(parsed.scalars.length).toBeGreaterThanOrEqual(6);
    expect(parsed.interfaces.length).toBeGreaterThanOrEqual(4);

    // No object types or link types from core
    expect(parsed.objectTypes).toHaveLength(0);
    expect(parsed.linkTypes).toHaveLength(0);

    // SPI schema has empty types (no concrete objects in core)
    expect(spiSchema.objectTypes).toHaveLength(0);
    expect(spiSchema.linkTypes).toHaveLength(0);
  });

  it('loads nhs-acute pack with core', async () => {
    const { parsed, spiSchema, packs } = await loadDomainPacks(DOMAIN_PACKS_DIR, ['core', 'nhs-acute']);

    expect(packs).toHaveLength(2);
    expect(packs[0]!.name).toBe('core');
    expect(packs[1]!.name).toBe('nhs-acute');

    // NHS acute provides 7 object types
    expect(parsed.objectTypes).toHaveLength(7);
    const objNames = parsed.objectTypes.map(t => t.name).sort();
    expect(objNames).toEqual(['Bed', 'Consultant', 'DischargeRecord', 'Patient', 'Staff', 'Transfer', 'Ward']);

    // 6 link types
    expect(parsed.linkTypes).toHaveLength(6);

    // SPI schema should have same counts
    expect(spiSchema.objectTypes).toHaveLength(7);
    expect(spiSchema.linkTypes).toHaveLength(6);
    expect(spiSchema.version).toBe(1);

    // nhs-acute opts into the FHIR + CDM capability-gated facades.
    expect(packs[1]!.capabilities).toEqual(expect.arrayContaining(['fhir', 'cdm']));
    // core declares no NHS facades.
    expect(packs[0]!.capabilities ?? []).not.toContain('fhir');
  });

  it('converts object types correctly', async () => {
    const { spiSchema } = await loadDomainPacks(DOMAIN_PACKS_DIR, ['core', 'nhs-acute']);

    const patient = spiSchema.objectTypes.find(t => t.name === 'Patient');
    expect(patient).toBeDefined();

    // 'id' field should be excluded (system column)
    const propNames = patient!.properties.map(p => p.name);
    expect(propNames).not.toContain('id');

    // nhsNumber should be present
    expect(propNames).toContain('nhsNumber');

    // Virtual @link fields should be excluded
    expect(propNames).not.toContain('currentWard');
    expect(propNames).not.toContain('currentBed');
    expect(propNames).not.toContain('admissions');
    expect(propNames).not.toContain('consultant');

    // Computed fields should be excluded
    const ward = spiSchema.objectTypes.find(t => t.name === 'Ward');
    const wardProps = ward!.properties.map(p => p.name);
    expect(wardProps).not.toContain('currentOccupancy');
  });

  it('extracts indexes from directives', async () => {
    const { spiSchema } = await loadDomainPacks(DOMAIN_PACKS_DIR, ['core', 'nhs-acute']);

    const patient = spiSchema.objectTypes.find(t => t.name === 'Patient');
    expect(patient!.indexes).toBeDefined();

    // nhsNumber has @unique @indexed
    const nhsIdx = patient!.indexes!.find(i => i.field === 'nhsNumber' && i.unique);
    expect(nhsIdx).toBeDefined();

    // name has @searchable
    const nameIdx = patient!.indexes!.find(i => i.field === 'name' && i.indexType === 'FULLTEXT');
    expect(nameIdx).toBeDefined();

    // Consultant gmcNumber has @unique @indexed
    const consultant = spiSchema.objectTypes.find(t => t.name === 'Consultant');
    const gmcIdx = consultant!.indexes!.find(i => i.field === 'gmcNumber' && i.unique);
    expect(gmcIdx).toBeDefined();
  });

  it('converts link types correctly', async () => {
    const { spiSchema } = await loadDomainPacks(DOMAIN_PACKS_DIR, ['core', 'nhs-acute']);

    const admittedTo = spiSchema.linkTypes.find(t => t.name === 'AdmittedTo');
    expect(admittedTo).toBeDefined();
    expect(admittedTo!.fromType).toBe('Patient');
    expect(admittedTo!.toType).toBe('Ward');
    expect(admittedTo!.cardinality).toBe('MANY_TO_ONE');
    expect(admittedTo!.properties).toBeDefined();
    expect(admittedTo!.properties!.length).toBeGreaterThanOrEqual(2);

    const occupiesBed = spiSchema.linkTypes.find(t => t.name === 'OccupiesBed');
    expect(occupiesBed!.cardinality).toBe('ONE_TO_ONE');
  });

  it('loads all packs when no names specified', async () => {
    const { parsed, packs } = await loadDomainPacks(DOMAIN_PACKS_DIR);

    // Should load core + all 3 domain packs
    expect(packs.length).toBeGreaterThanOrEqual(4);
    expect(packs[0]!.name).toBe('core'); // core always first

    // Should have types from multiple packs
    const objNames = parsed.objectTypes.map(t => t.name);
    expect(objNames).toContain('Patient');   // nhs-acute
    expect(objNames).toContain('Customer');  // aml
    expect(objNames).toContain('Product');   // supply-chain
  });

  it('ensures core is loaded first even when specified later', async () => {
    const { packs } = await loadDomainPacks(DOMAIN_PACKS_DIR, ['nhs-acute', 'core']);
    expect(packs[0]!.name).toBe('core');
  });

  it('marks required fields correctly', async () => {
    const { spiSchema } = await loadDomainPacks(DOMAIN_PACKS_DIR, ['core', 'nhs-acute']);

    const patient = spiSchema.objectTypes.find(t => t.name === 'Patient');
    const nameField = patient!.properties.find(p => p.name === 'name');
    expect(nameField!.required).toBe(true);

    // nhsNumber is not required (no !)
    const nhsField = patient!.properties.find(p => p.name === 'nhsNumber');
    expect(nhsField!.required).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Extra directory loading (multi-directory support)
// ---------------------------------------------------------------------------

describe('loadDomainPacks with extra directories', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'of-extra-packs-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads packs from an extra directory alongside primary packs', async () => {
    // Create a minimal pack (no schema files — manifests-only packs are valid)
    const packDir = resolve(tmpDir, 'test-extra');
    mkdirSync(packDir);
    writeFileSync(resolve(packDir, 'pack.yaml'), [
      'name: test-extra',
      'version: 0.1.0',
      'namespace: test_extra',
      'description: "External test pack"',
    ].join('\n'));

    const { packs } = await loadDomainPacks(DOMAIN_PACKS_DIR, ['core', 'test-extra'], [tmpDir]);

    expect(packs).toHaveLength(2);
    const names = packs.map(p => p.name);
    expect(names).toContain('core');
    expect(names).toContain('test-extra');
  });

  it('detects a direct pack path (pack.yaml at root of extra dir)', async () => {
    // Point directly at a pack directory — no subdirectory scanning needed
    writeFileSync(resolve(tmpDir, 'pack.yaml'), [
      'name: direct-pack',
      'version: 0.1.0',
      'namespace: direct',
    ].join('\n'));

    const { packs } = await loadDomainPacks(DOMAIN_PACKS_DIR, ['core', 'direct-pack'], [tmpDir]);

    expect(packs).toHaveLength(2);
    expect(packs.map(p => p.name)).toContain('direct-pack');
  });

  it('primary directory packs take precedence over extra directory packs', async () => {
    // Create a pack with the same name as a primary pack
    const packDir = resolve(tmpDir, 'core-override');
    mkdirSync(packDir);
    writeFileSync(resolve(packDir, 'pack.yaml'), [
      'name: core',
      'version: 99.0.0',
      'namespace: core_override',
    ].join('\n'));

    const { packs } = await loadDomainPacks(DOMAIN_PACKS_DIR, ['core'], [tmpDir]);

    expect(packs).toHaveLength(1);
    // Should load the real core, not the override
    expect(packs[0]!.version).not.toBe('99.0.0');
  });

  it('skips non-existent extra directories gracefully', async () => {
    const { packs } = await loadDomainPacks(DOMAIN_PACKS_DIR, ['core'], ['/nonexistent/path']);

    expect(packs).toHaveLength(1);
    expect(packs[0]!.name).toBe('core');
  });

  it('loads packs from multiple extra directories', async () => {
    const dir1 = resolve(tmpDir, 'extras-1');
    const dir2 = resolve(tmpDir, 'extras-2');
    mkdirSync(dir1);
    mkdirSync(dir2);

    const pack1Dir = resolve(dir1, 'pack-alpha');
    mkdirSync(pack1Dir);
    writeFileSync(resolve(pack1Dir, 'pack.yaml'), [
      'name: pack-alpha',
      'version: 0.1.0',
      'namespace: alpha',
    ].join('\n'));

    const pack2Dir = resolve(dir2, 'pack-beta');
    mkdirSync(pack2Dir);
    writeFileSync(resolve(pack2Dir, 'pack.yaml'), [
      'name: pack-beta',
      'version: 0.1.0',
      'namespace: beta',
    ].join('\n'));

    const { packs } = await loadDomainPacks(
      DOMAIN_PACKS_DIR,
      ['core', 'pack-alpha', 'pack-beta'],
      [dir1, dir2],
    );

    const names = packs.map(p => p.name);
    expect(names).toContain('core');
    expect(names).toContain('pack-alpha');
    expect(names).toContain('pack-beta');
  });

  it('applies pack name filter to extra directory packs', async () => {
    const packDir = resolve(tmpDir, 'filtered-pack');
    mkdirSync(packDir);
    writeFileSync(resolve(packDir, 'pack.yaml'), [
      'name: filtered-pack',
      'version: 0.1.0',
      'namespace: filtered',
    ].join('\n'));

    // Request only 'core' — filtered-pack should be discovered but not loaded
    const { packs } = await loadDomainPacks(DOMAIN_PACKS_DIR, ['core'], [tmpDir]);

    const names = packs.map(p => p.name);
    expect(names).toContain('core');
    expect(names).not.toContain('filtered-pack');
  });

  it('empty extra dirs array behaves like no extra dirs', async () => {
    const { packs } = await loadDomainPacks(DOMAIN_PACKS_DIR, ['core'], []);

    expect(packs).toHaveLength(1);
    expect(packs[0]!.name).toBe('core');
  });

  it('skips malformed pack.yaml in extra directory without aborting', async () => {
    // Create one valid pack and one malformed pack in the same extra directory
    const goodDir = resolve(tmpDir, 'good-pack');
    mkdirSync(goodDir);
    writeFileSync(resolve(goodDir, 'pack.yaml'), [
      'name: good-pack',
      'version: 0.1.0',
      'namespace: good',
    ].join('\n'));

    const badDir = resolve(tmpDir, 'bad-pack');
    mkdirSync(badDir);
    writeFileSync(resolve(badDir, 'pack.yaml'), '{{{{invalid yaml content!!!!');

    // Should load core and good-pack, skipping bad-pack gracefully
    const { packs } = await loadDomainPacks(
      DOMAIN_PACKS_DIR,
      ['core', 'good-pack'],
      [tmpDir],
    );

    const names = packs.map(p => p.name);
    expect(names).toContain('core');
    expect(names).toContain('good-pack');
  });

  it('skips malformed direct pack.yaml without aborting', async () => {
    // Point directly at a directory with an invalid pack.yaml
    writeFileSync(resolve(tmpDir, 'pack.yaml'), '- not\n- an\n- object');

    // Should not throw — just skip the malformed pack
    const { packs } = await loadDomainPacks(DOMAIN_PACKS_DIR, ['core'], [tmpDir]);

    expect(packs).toHaveLength(1);
    expect(packs[0]!.name).toBe('core');
  });

  it('skips pack.yaml missing name field without aborting', async () => {
    const packDir = resolve(tmpDir, 'nameless-pack');
    mkdirSync(packDir);
    writeFileSync(resolve(packDir, 'pack.yaml'), [
      'version: 0.1.0',
      'namespace: nameless',
    ].join('\n'));

    // Should skip the nameless pack gracefully
    const { packs } = await loadDomainPacks(DOMAIN_PACKS_DIR, ['core'], [tmpDir]);

    expect(packs).toHaveLength(1);
    expect(packs[0]!.name).toBe('core');
  });
});

// ---------------------------------------------------------------------------
// CI fixture external pack (always available — no sibling repo required)
// ---------------------------------------------------------------------------

const FIXTURE_PACK_DIR = resolve(__dirname, 'fixtures', 'external-pack');

describe('loadDomainPacks with CI fixture external pack', () => {
  it('loads fixture pack schema, actions, permissions, and connectors', async () => {
    const result = await loadDomainPacks(
      DOMAIN_PACKS_DIR,
      ['core', 'test-external'],
      [FIXTURE_PACK_DIR],
    );

    // Pack discovered and loaded
    expect(result.packs.map(p => p.name)).toContain('test-external');

    // ODL parsed: 1 object type (Widget), 1 link (BelongsTo), 1 action (ActivateWidget)
    const objNames = result.parsed.objectTypes.map(t => t.name);
    expect(objNames).toContain('Widget');
    expect(result.parsed.linkTypes.map(l => l.name)).toContain('BelongsTo');
    expect(result.parsed.actionTypes.map(a => a.name)).toContain('ActivateWidget');

    // SPI schema conversion
    const widget = result.spiSchema.objectTypes.find(t => t.name === 'Widget');
    expect(widget).toBeDefined();
    expect(widget!.properties.map(p => p.name)).toContain('serialNumber');
    expect(widget!.properties.map(p => p.name)).toContain('name');
    expect(widget!.properties.map(p => p.name)).not.toContain('id');

    // Indexes extracted
    const uniqueIdx = widget!.indexes!.find(i => i.field === 'serialNumber' && i.unique);
    expect(uniqueIdx).toBeDefined();
    const searchIdx = widget!.indexes!.find(i => i.field === 'name' && i.indexType === 'FULLTEXT');
    expect(searchIdx).toBeDefined();

    // Action manifest loaded and cross-referenced
    const manifest = result.manifestRegistry.get('ActivateWidget');
    expect(manifest).toBeDefined();
    expect(manifest!.version).toBe(1);
    expect(manifest!.preconditions.length).toBe(1);
    expect(manifest!.effects.length).toBe(1);
  });

  it('loads OpenFGA permission overrides from fixture pack', async () => {
    const result = await loadDomainPacks(
      DOMAIN_PACKS_DIR,
      ['core', 'test-external'],
      [FIXTURE_PACK_DIR],
    );

    expect(result.permissionOverrides.length).toBeGreaterThan(0);
    // The fixture .fga file defines a 'widget' type with 'owner' relation
    const widgetFga = result.permissionOverrides.find(o => o.includes('type widget'));
    expect(widgetFga).toBeDefined();
    expect(widgetFga).toContain('define owner');
    expect(widgetFga).toContain('define can_activate');
  });

  it('loads connector manifests from fixture pack', async () => {
    const result = await loadDomainPacks(
      DOMAIN_PACKS_DIR,
      ['core', 'test-external'],
      [FIXTURE_PACK_DIR],
    );

    expect(result.connectorManifests.length).toBeGreaterThan(0);
    const restConnector = result.connectorManifests.find(c => c.packName === 'test-external');
    expect(restConnector).toBeDefined();
    expect(restConnector!.connector).toBe('rest');
    expect(restConnector!.config['datasource']).toBe('Widget_API');
  });

  it('tracks pack origin (external vs primary)', async () => {
    const result = await loadDomainPacks(
      DOMAIN_PACKS_DIR,
      ['core', 'test-external'],
      [FIXTURE_PACK_DIR],
    );

    const coreInfo = result.packInfos.find(p => p.manifest.name === 'core');
    expect(coreInfo).toBeDefined();
    expect(coreInfo!.external).toBe(false);

    const extInfo = result.packInfos.find(p => p.manifest.name === 'test-external');
    expect(extInfo).toBeDefined();
    expect(extInfo!.external).toBe(true);

    // Per-pack type counts (Widget object, BelongsTo link, ActivateWidget action, WidgetStatus enum)
    expect(extInfo!.typeCounts.objectTypes).toBe(1);
    expect(extInfo!.typeCounts.linkTypes).toBe(1);
    expect(extInfo!.typeCounts.actionTypes).toBe(1);
    expect(extInfo!.typeCounts.enums).toBe(1);

    // Core pack has no object/link/action types (only scalars + interfaces)
    expect(coreInfo!.typeCounts.objectTypes).toBe(0);
  });

  it('merges fixture pack with primary nhs-acute pack', async () => {
    const result = await loadDomainPacks(
      DOMAIN_PACKS_DIR,
      ['core', 'nhs-acute', 'test-external'],
      [FIXTURE_PACK_DIR],
    );

    const objNames = result.parsed.objectTypes.map(t => t.name);
    expect(objNames).toContain('Patient');  // nhs-acute
    expect(objNames).toContain('Widget');   // test-external
    expect(result.spiSchema.objectTypes.length).toBe(8); // 7 nhs-acute + 1 fixture
  });

  it('loads fixture pack from DOMAIN_PACKS_EXTRA_DIRS env var', async () => {
    const prev = process.env['DOMAIN_PACKS_EXTRA_DIRS'];
    try {
      process.env['DOMAIN_PACKS_EXTRA_DIRS'] = FIXTURE_PACK_DIR;

      const { packs } = await loadDomainPacks(DOMAIN_PACKS_DIR, ['core', 'test-external']);

      expect(packs.map(p => p.name)).toContain('test-external');
    } finally {
      if (prev === undefined) {
        delete process.env['DOMAIN_PACKS_EXTRA_DIRS'];
      } else {
        process.env['DOMAIN_PACKS_EXTRA_DIRS'] = prev;
      }
    }
  });

  it('loads seed manifests from fixture pack', async () => {
    const result = await loadDomainPacks(
      DOMAIN_PACKS_DIR,
      ['core', 'test-external'],
      [FIXTURE_PACK_DIR],
    );

    expect(result.seedManifests.length).toBe(1);
    const seed = result.seedManifests[0]!;
    expect(seed.packName).toBe('test-external');
    expect(seed.objects).toHaveLength(2);
    expect(seed.links).toHaveLength(1);

    // Check object refs
    expect(seed.objects[0]!.ref).toBe('parent-widget');
    expect(seed.objects[0]!.type).toBe('Widget');
    expect(seed.objects[0]!.fields['name']).toBe('Root Widget');

    expect(seed.objects[1]!.ref).toBe('child-widget');
    expect(seed.objects[1]!.type).toBe('Widget');

    // Check link references point to seed refs
    expect(seed.links[0]!.type).toBe('BelongsTo');
    expect(seed.links[0]!.from).toBe('child-widget');
    expect(seed.links[0]!.to).toBe('parent-widget');
  });

  it('validates dependency constraints (core >= 1.0.0 satisfied)', async () => {
    // This should not throw — core is v1.0.0 and fixture requires >=1.0.0
    const result = await loadDomainPacks(
      DOMAIN_PACKS_DIR,
      ['core', 'test-external'],
      [FIXTURE_PACK_DIR],
    );

    expect(result.packs.map(p => p.name)).toContain('test-external');
  });
});

// ---------------------------------------------------------------------------
// External RCE pack import (lives outside monorepo at ../silmaril-dp-rce)
// ---------------------------------------------------------------------------

const RCE_PACK_DIR = resolve(DOMAIN_PACKS_DIR, '..', '..', 'silmaril-dp-rce');
const rcePackAvailable = existsSync(resolve(RCE_PACK_DIR, 'pack.yaml'));

describe.skipIf(!rcePackAvailable)('loadDomainPacks with external RCE pack', () => {

  it('loads RCE pack from external directory via extraDirs parameter', async () => {
    const { parsed, spiSchema, packs } = await loadDomainPacks(
      DOMAIN_PACKS_DIR,
      ['core', 'rce'],
      [RCE_PACK_DIR],
    );

    const packNames = packs.map(p => p.name);
    expect(packNames).toContain('core');
    expect(packNames).toContain('rce');

    // RCE provides 9 object types
    const objNames = parsed.objectTypes.map(t => t.name).sort();
    expect(objNames).toEqual([
      'Approach', 'AuditEvent', 'Claim', 'ConstitutionRule', 'CorpusEntry',
      'Instance', 'PersonalityConfig', 'Response', 'SystemStateItem',
    ]);

    // 9 link types
    expect(parsed.linkTypes.map(l => l.name).sort()).toEqual([
      'ConfiguredAs', 'EmploysApproach', 'ForkedFrom',
      'GovernedBy', 'GroundedIn', 'HasSystemState',
      'InstanceResponse', 'OwnsCorpus', 'ResponseClaim',
    ]);

    // 6 action types
    expect(parsed.actionTypes.map(a => a.name).sort()).toEqual([
      'AdmitCorpus', 'AmendConstitution', 'ForkInstance',
      'RecordVerdict', 'RegisterApproach', 'UpdateSystemState',
    ]);

    // SPI schema matches
    expect(spiSchema.objectTypes).toHaveLength(9);
    expect(spiSchema.linkTypes).toHaveLength(9);
  });

  it('loads RCE pack from DOMAIN_PACKS_EXTRA_DIRS env var', async () => {
    const prev = process.env['DOMAIN_PACKS_EXTRA_DIRS'];
    try {
      process.env['DOMAIN_PACKS_EXTRA_DIRS'] = RCE_PACK_DIR;

      // Call without explicit extraDirs — should pick up env var
      const { packs } = await loadDomainPacks(DOMAIN_PACKS_DIR, ['core', 'rce']);

      expect(packs.map(p => p.name)).toContain('rce');
    } finally {
      if (prev === undefined) {
        delete process.env['DOMAIN_PACKS_EXTRA_DIRS'];
      } else {
        process.env['DOMAIN_PACKS_EXTRA_DIRS'] = prev;
      }
    }
  });

  it('SPI conversion preserves RCE object properties and indexes', async () => {
    const { spiSchema } = await loadDomainPacks(
      DOMAIN_PACKS_DIR,
      ['core', 'rce'],
      [RCE_PACK_DIR],
    );

    // Instance: name indexed + searchable, status present, id excluded
    const instance = spiSchema.objectTypes.find(t => t.name === 'Instance')!;
    expect(instance).toBeDefined();
    const instanceProps = instance.properties.map(p => p.name);
    expect(instanceProps).toContain('name');
    expect(instanceProps).toContain('status');
    expect(instanceProps).not.toContain('id');
    // @link virtual fields excluded
    expect(instanceProps).not.toContain('personality');
    expect(instanceProps).not.toContain('corpus');
    // @computed fields excluded
    expect(instanceProps).not.toContain('corpusSize');
    expect(instanceProps).not.toContain('approachCount');

    const nameIdx = instance.indexes!.find(i => i.field === 'name');
    expect(nameIdx).toBeDefined();
    const searchIdx = instance.indexes!.find(i => i.field === 'name' && i.indexType === 'FULLTEXT');
    expect(searchIdx).toBeDefined();

    // CorpusEntry: contentHash is @unique
    const entry = spiSchema.objectTypes.find(t => t.name === 'CorpusEntry')!;
    const hashIdx = entry.indexes!.find(i => i.field === 'contentHash' && i.unique);
    expect(hashIdx).toBeDefined();

    // Response: claimsTotal, claimsVerified, claimsBlocked present
    const response = spiSchema.objectTypes.find(t => t.name === 'Response')!;
    const responseProps = response.properties.map(p => p.name);
    expect(responseProps).toContain('claimsTotal');
    expect(responseProps).toContain('claimsVerified');
    expect(responseProps).toContain('claimsBlocked');
    expect(responseProps).toContain('verificationOutcome');
    // @link field excluded
    expect(responseProps).not.toContain('claims');
  });

  it('SPI conversion preserves RCE link types and properties', async () => {
    const { spiSchema } = await loadDomainPacks(
      DOMAIN_PACKS_DIR,
      ['core', 'rce'],
      [RCE_PACK_DIR],
    );

    const ownsCorpus = spiSchema.linkTypes.find(l => l.name === 'OwnsCorpus')!;
    expect(ownsCorpus.fromType).toBe('Instance');
    expect(ownsCorpus.toType).toBe('CorpusEntry');
    expect(ownsCorpus.cardinality).toBe('ONE_TO_MANY');
    expect(ownsCorpus.properties!.map(p => p.name)).toContain('admissionDate');

    const groundedIn = spiSchema.linkTypes.find(l => l.name === 'GroundedIn')!;
    expect(groundedIn.fromType).toBe('Claim');
    expect(groundedIn.toType).toBe('CorpusEntry');
    expect(groundedIn.cardinality).toBe('MANY_TO_MANY');
    expect(groundedIn.properties!.map(p => p.name)).toContain('confidence');

    const forkedFrom = spiSchema.linkTypes.find(l => l.name === 'ForkedFrom')!;
    expect(forkedFrom.fromType).toBe('Instance');
    expect(forkedFrom.toType).toBe('Instance');
    expect(forkedFrom.cardinality).toBe('MANY_TO_ONE');
  });

  it('RCE action manifests cross-reference against ODL schema', async () => {
    const { manifestRegistry, parsed } = await loadDomainPacks(
      DOMAIN_PACKS_DIR,
      ['core', 'rce'],
      [RCE_PACK_DIR],
    );

    // Every action type defined in ODL has a matching YAML manifest
    for (const actionType of parsed.actionTypes) {
      const manifest = manifestRegistry.get(actionType.name);
      expect(manifest, `Missing manifest for ${actionType.name}`).toBeDefined();
    }

    // Spot-check structure of a loaded manifest
    const recordVerdict = manifestRegistry.get('RecordVerdict')!;
    expect(recordVerdict.version).toBe(1);
    expect(recordVerdict.preconditions.length).toBeGreaterThan(0);
    expect(recordVerdict.effects.map(e => e.type)).toEqual([
      'updateObject', 'createObject', 'createLink',
    ]);
  });

  it('merges external RCE pack with primary nhs-acute pack', async () => {
    const { parsed, spiSchema } = await loadDomainPacks(
      DOMAIN_PACKS_DIR,
      ['core', 'nhs-acute', 'rce'],
      [RCE_PACK_DIR],
    );

    // Both packs' types present in merged schema
    const objNames = parsed.objectTypes.map(t => t.name);
    expect(objNames).toContain('Patient');     // nhs-acute
    expect(objNames).toContain('Ward');        // nhs-acute
    expect(objNames).toContain('Instance');    // rce
    expect(objNames).toContain('CorpusEntry'); // rce

    // SPI has combined types
    expect(spiSchema.objectTypes.length).toBe(16); // 7 nhs-acute + 9 rce
    expect(spiSchema.linkTypes.length).toBe(15);   // 6 nhs-acute + 9 rce
  });
});

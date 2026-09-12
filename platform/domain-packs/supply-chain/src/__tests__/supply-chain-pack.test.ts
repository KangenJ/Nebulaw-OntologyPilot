/**
 * Tests for the Supply Chain domain pack.
 *
 * Validates:
 * - All ODL files parse and validate (combined schema)
 * - All action manifests parse correctly
 * - Pack manifest structure
 * - OpenFGA permissions model content
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOdl, validateSchema } from '@openfoundry/odl';
import { parseActionManifest } from '@openfoundry/actions';
import { parse as parseYaml } from 'yaml';
import type { ParsedSchema, FieldDirective } from '@openfoundry/odl';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACK_ROOT = resolve(__dirname, '..', '..');

// ─── Helpers ───

function readOdl(filename: string): string {
  return readFileSync(resolve(PACK_ROOT, 'schema', filename), 'utf-8');
}

function readAction(filename: string): string {
  return readFileSync(resolve(PACK_ROOT, 'actions', filename), 'utf-8');
}

function findDirective<K extends FieldDirective['kind']>(
  directives: FieldDirective[],
  kind: K,
): Extract<FieldDirective, { kind: K }> | undefined {
  return directives.find(d => d.kind === kind) as Extract<FieldDirective, { kind: K }> | undefined;
}

// ─── Load all ODL files as combined source ───

const ODL_FILES = [
  'enums.odl',
  'supplier.odl',
  'facility.odl',
  'product.odl',
  'purchase-order.odl',
  'shipment.odl',
  'inventory-record.odl',
  'links.odl',
  'actions.odl',
];

function buildCombinedSource(): string {
  const sources = ODL_FILES.map(f => readOdl(f));
  const first = sources[0]!;
  const rest = sources.slice(1).map(s =>
    s.replace(/^extend schema @namespace\([^)]+\)\s*/m, ''),
  );
  return [first, ...rest].join('\n\n');
}

const combinedSource = buildCombinedSource();

// ─── Tests ───

describe('Supply Chain Domain Pack — ODL Schema Parsing', () => {
  let schema: ParsedSchema;

  schema = parseOdl(combinedSource);

  describe('namespace', () => {
    it('declares supply.chain namespace', () => {
      expect(schema.namespace).toBeDefined();
      expect(schema.namespace!.name).toBe('supply.chain');
      expect(schema.namespace!.version).toBe('0.1.0');
    });
  });

  describe('enums', () => {
    it('declares all 7 enums', () => {
      const enumNames = schema.enums.map(e => e.name).sort();
      expect(enumNames).toEqual([
        'FacilityStatus',
        'FacilityType',
        'OrderStatus',
        'ShipmentStatus',
        'StockLevel',
        'SupplierTier',
        'TransportMode',
      ]);
    });

    it('FacilityType has correct values', () => {
      const e = schema.enums.find(e => e.name === 'FacilityType')!;
      expect(e.values.map(v => v.name)).toEqual([
        'FACTORY', 'WAREHOUSE', 'DISTRIBUTION_CENTER', 'PORT',
      ]);
    });

    it('FacilityStatus has correct values', () => {
      const e = schema.enums.find(e => e.name === 'FacilityStatus')!;
      expect(e.values.map(v => v.name)).toEqual([
        'OPERATIONAL', 'MAINTENANCE', 'DISRUPTED', 'CLOSED',
      ]);
    });

    it('SupplierTier has correct values', () => {
      const e = schema.enums.find(e => e.name === 'SupplierTier')!;
      expect(e.values.map(v => v.name)).toEqual([
        'STRATEGIC', 'PREFERRED', 'APPROVED', 'PROBATION',
      ]);
    });

    it('OrderStatus has correct values', () => {
      const e = schema.enums.find(e => e.name === 'OrderStatus')!;
      expect(e.values.map(v => v.name)).toEqual([
        'DRAFT', 'SUBMITTED', 'CONFIRMED', 'IN_PRODUCTION', 'SHIPPED', 'DELIVERED', 'CANCELLED',
      ]);
    });

    it('ShipmentStatus has correct values', () => {
      const e = schema.enums.find(e => e.name === 'ShipmentStatus')!;
      expect(e.values.map(v => v.name)).toEqual([
        'PENDING', 'IN_TRANSIT', 'DELAYED', 'CUSTOMS_HOLD', 'DELIVERED', 'LOST',
      ]);
    });

    it('TransportMode has correct values', () => {
      const e = schema.enums.find(e => e.name === 'TransportMode')!;
      expect(e.values.map(v => v.name)).toEqual([
        'SEA', 'AIR', 'ROAD', 'RAIL', 'MULTIMODAL',
      ]);
    });

    it('StockLevel has correct values', () => {
      const e = schema.enums.find(e => e.name === 'StockLevel')!;
      expect(e.values.map(v => v.name)).toEqual([
        'OVERSTOCKED', 'ADEQUATE', 'LOW', 'CRITICAL', 'STOCKOUT',
      ]);
    });
  });

  describe('objectTypes (6)', () => {
    it('declares all 6 ObjectTypes', () => {
      const names = schema.objectTypes.map(t => t.name).sort();
      expect(names).toEqual([
        'Facility', 'InventoryRecord', 'Product', 'PurchaseOrder', 'Shipment', 'Supplier',
      ]);
    });

    describe('Supplier', () => {
      it('has all required fields', () => {
        const supplier = schema.objectTypes.find(t => t.name === 'Supplier')!;
        const fieldNames = supplier.fields.map(f => f.name);
        expect(fieldNames).toContain('id');
        expect(fieldNames).toContain('name');
        expect(fieldNames).toContain('code');
        expect(fieldNames).toContain('tier');
        expect(fieldNames).toContain('contactName');
        expect(fieldNames).toContain('contactEmail');
        expect(fieldNames).toContain('country');
        expect(fieldNames).toContain('leadTimeDays');
        expect(fieldNames).toContain('onTimeDeliveryRate');
        expect(fieldNames).toContain('products');
      });

      it('code is @unique @indexed', () => {
        const supplier = schema.objectTypes.find(t => t.name === 'Supplier')!;
        const code = supplier.fields.find(f => f.name === 'code')!;
        expect(findDirective(code.directives, 'unique')).toBeDefined();
        expect(findDirective(code.directives, 'indexed')).toBeDefined();
      });

      it('name is @indexed @searchable', () => {
        const supplier = schema.objectTypes.find(t => t.name === 'Supplier')!;
        const name = supplier.fields.find(f => f.name === 'name')!;
        expect(findDirective(name.directives, 'indexed')).toBeDefined();
        expect(findDirective(name.directives, 'searchable')).toBeDefined();
      });

      it('leadTimeDays has @constraint', () => {
        const supplier = schema.objectTypes.find(t => t.name === 'Supplier')!;
        const field = supplier.fields.find(f => f.name === 'leadTimeDays')!;
        const constraint = findDirective(field.directives, 'constraint');
        expect(constraint).toBeDefined();
        expect(constraint!.expr).toBe('value >= 0');
      });

      it('contactEmail is @sensitive', () => {
        const supplier = schema.objectTypes.find(t => t.name === 'Supplier')!;
        const field = supplier.fields.find(f => f.name === 'contactEmail')!;
        expect(findDirective(field.directives, 'sensitive')).toBeDefined();
      });
    });

    describe('Facility', () => {
      it('has address field', () => {
        const facility = schema.objectTypes.find(t => t.name === 'Facility')!;
        const fieldNames = facility.fields.map(f => f.name);
        expect(fieldNames).toContain('address');
      });

      it('has capacity with @constraint', () => {
        const facility = schema.objectTypes.find(t => t.name === 'Facility')!;
        const capacity = facility.fields.find(f => f.name === 'capacity')!;
        const constraint = findDirective(capacity.directives, 'constraint');
        expect(constraint).toBeDefined();
        expect(constraint!.expr).toBe('value > 0');
      });

      it('has currentUtilization as @computed', () => {
        const facility = schema.objectTypes.find(t => t.name === 'Facility')!;
        const util = facility.fields.find(f => f.name === 'currentUtilization')!;
        const computed = findDirective(util.directives, 'computed');
        expect(computed).toBeDefined();
        expect(computed!.fn).toBe('countLinks');
        expect(computed!.cache).toBe('LAZY');
      });

      it('code is @unique @indexed', () => {
        const facility = schema.objectTypes.find(t => t.name === 'Facility')!;
        const code = facility.fields.find(f => f.name === 'code')!;
        expect(findDirective(code.directives, 'unique')).toBeDefined();
        expect(findDirective(code.directives, 'indexed')).toBeDefined();
      });
    });

    describe('Product', () => {
      it('sku is @unique @indexed', () => {
        const product = schema.objectTypes.find(t => t.name === 'Product')!;
        const sku = product.fields.find(f => f.name === 'sku')!;
        expect(findDirective(sku.directives, 'unique')).toBeDefined();
        expect(findDirective(sku.directives, 'indexed')).toBeDefined();
      });

      it('reorderPoint has @constraint(value >= 0)', () => {
        const product = schema.objectTypes.find(t => t.name === 'Product')!;
        const field = product.fields.find(f => f.name === 'reorderPoint')!;
        const constraint = findDirective(field.directives, 'constraint');
        expect(constraint).toBeDefined();
        expect(constraint!.expr).toBe('value >= 0');
      });

      it('reorderQuantity has @constraint(value > 0)', () => {
        const product = schema.objectTypes.find(t => t.name === 'Product')!;
        const field = product.fields.find(f => f.name === 'reorderQuantity')!;
        const constraint = findDirective(field.directives, 'constraint');
        expect(constraint).toBeDefined();
        expect(constraint!.expr).toBe('value > 0');
      });
    });

    describe('PurchaseOrder', () => {
      it('orderNumber is @unique @indexed @immutable', () => {
        const po = schema.objectTypes.find(t => t.name === 'PurchaseOrder')!;
        const field = po.fields.find(f => f.name === 'orderNumber')!;
        expect(findDirective(field.directives, 'unique')).toBeDefined();
        expect(findDirective(field.directives, 'indexed')).toBeDefined();
        expect(findDirective(field.directives, 'immutable')).toBeDefined();
      });

      it('quantity has @constraint(value > 0)', () => {
        const po = schema.objectTypes.find(t => t.name === 'PurchaseOrder')!;
        const field = po.fields.find(f => f.name === 'quantity')!;
        const constraint = findDirective(field.directives, 'constraint');
        expect(constraint).toBeDefined();
        expect(constraint!.expr).toBe('value > 0');
      });

      it('unitCost has @constraint(value > 0)', () => {
        const po = schema.objectTypes.find(t => t.name === 'PurchaseOrder')!;
        const field = po.fields.find(f => f.name === 'unitCost')!;
        const constraint = findDirective(field.directives, 'constraint');
        expect(constraint).toBeDefined();
        expect(constraint!.expr).toBe('value > 0');
      });
    });

    describe('Shipment', () => {
      it('trackingNumber is @unique @indexed', () => {
        const shipment = schema.objectTypes.find(t => t.name === 'Shipment')!;
        const field = shipment.fields.find(f => f.name === 'trackingNumber')!;
        expect(findDirective(field.directives, 'unique')).toBeDefined();
        expect(findDirective(field.directives, 'indexed')).toBeDefined();
      });

      it('has all required fields', () => {
        const shipment = schema.objectTypes.find(t => t.name === 'Shipment')!;
        const fieldNames = shipment.fields.map(f => f.name);
        expect(fieldNames).toContain('status');
        expect(fieldNames).toContain('transportMode');
        expect(fieldNames).toContain('quantity');
        expect(fieldNames).toContain('departureDate');
        expect(fieldNames).toContain('estimatedArrival');
        expect(fieldNames).toContain('actualArrival');
        expect(fieldNames).toContain('order');
        expect(fieldNames).toContain('origin');
        expect(fieldNames).toContain('destination');
      });
    });

    describe('InventoryRecord', () => {
      it('quantity has @constraint(value >= 0)', () => {
        const inv = schema.objectTypes.find(t => t.name === 'InventoryRecord')!;
        const field = inv.fields.find(f => f.name === 'quantity')!;
        const constraint = findDirective(field.directives, 'constraint');
        expect(constraint).toBeDefined();
        expect(constraint!.expr).toBe('value >= 0');
      });

      it('reservedQuantity has @constraint(value >= 0)', () => {
        const inv = schema.objectTypes.find(t => t.name === 'InventoryRecord')!;
        const field = inv.fields.find(f => f.name === 'reservedQuantity')!;
        const constraint = findDirective(field.directives, 'constraint');
        expect(constraint).toBeDefined();
        expect(constraint!.expr).toBe('value >= 0');
      });

      it('has product and facility reference fields', () => {
        const inv = schema.objectTypes.find(t => t.name === 'InventoryRecord')!;
        const fieldNames = inv.fields.map(f => f.name);
        expect(fieldNames).toContain('product');
        expect(fieldNames).toContain('facility');
      });
    });
  });

  describe('linkTypes (7)', () => {
    it('declares all 7 LinkTypes', () => {
      const names = schema.linkTypes.map(t => t.name).sort();
      expect(names).toEqual([
        'InventoryAt', 'InventoryOf', 'OrderedFrom',
        'ShipmentForOrder', 'ShipsFrom', 'ShipsTo', 'SuppliesProduct',
      ]);
    });

    it('SuppliesProduct: Supplier -> Product, MANY_TO_MANY', () => {
      const lt = schema.linkTypes.find(t => t.name === 'SuppliesProduct')!;
      expect(lt.from).toBe('Supplier');
      expect(lt.to).toBe('Product');
      expect(lt.cardinality).toBe('MANY_TO_MANY');
      expect(lt.fields.map(f => f.name)).toContain('leadTimeDays');
      expect(lt.fields.map(f => f.name)).toContain('unitCost');
      expect(lt.fields.map(f => f.name)).toContain('minOrderQuantity');
      expect(lt.fields.map(f => f.name)).toContain('preferredSupplier');
    });

    it('OrderedFrom: PurchaseOrder -> Supplier, MANY_TO_ONE', () => {
      const lt = schema.linkTypes.find(t => t.name === 'OrderedFrom')!;
      expect(lt.from).toBe('PurchaseOrder');
      expect(lt.to).toBe('Supplier');
      expect(lt.cardinality).toBe('MANY_TO_ONE');
      expect(lt.fields.map(f => f.name)).toContain('orderedAt');
    });

    it('ShipmentForOrder: Shipment -> PurchaseOrder, MANY_TO_ONE', () => {
      const lt = schema.linkTypes.find(t => t.name === 'ShipmentForOrder')!;
      expect(lt.from).toBe('Shipment');
      expect(lt.to).toBe('PurchaseOrder');
      expect(lt.cardinality).toBe('MANY_TO_ONE');
    });

    it('ShipsFrom: Shipment -> Facility, MANY_TO_ONE', () => {
      const lt = schema.linkTypes.find(t => t.name === 'ShipsFrom')!;
      expect(lt.from).toBe('Shipment');
      expect(lt.to).toBe('Facility');
      expect(lt.cardinality).toBe('MANY_TO_ONE');
    });

    it('ShipsTo: Shipment -> Facility, MANY_TO_ONE', () => {
      const lt = schema.linkTypes.find(t => t.name === 'ShipsTo')!;
      expect(lt.from).toBe('Shipment');
      expect(lt.to).toBe('Facility');
      expect(lt.cardinality).toBe('MANY_TO_ONE');
    });

    it('InventoryAt: InventoryRecord -> Facility, MANY_TO_ONE', () => {
      const lt = schema.linkTypes.find(t => t.name === 'InventoryAt')!;
      expect(lt.from).toBe('InventoryRecord');
      expect(lt.to).toBe('Facility');
      expect(lt.cardinality).toBe('MANY_TO_ONE');
    });

    it('InventoryOf: InventoryRecord -> Product, MANY_TO_ONE', () => {
      const lt = schema.linkTypes.find(t => t.name === 'InventoryOf')!;
      expect(lt.from).toBe('InventoryRecord');
      expect(lt.to).toBe('Product');
      expect(lt.cardinality).toBe('MANY_TO_ONE');
    });
  });

  describe('action types', () => {
    it('defines 4 action types', () => {
      expect(schema.actionTypes).toHaveLength(4);
      const names = schema.actionTypes.map(a => a.name);
      expect(names).toContain('CreateOrder');
      expect(names).toContain('ShipOrder');
      expect(names).toContain('ReceiveShipment');
      expect(names).toContain('CancelOrder');
    });
  });
});

describe('Supply Chain Domain Pack — ODL Validation', () => {
  it('validates combined schema without errors', () => {
    const schema = parseOdl(combinedSource);
    const result = validateSchema(schema);

    if (result.errors.length > 0) {
      for (const err of result.errors) {
        console.error(`[${err.code}] ${err.message}`);
      }
    }

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

describe('Supply Chain Domain Pack — Individual ODL Files', () => {
  for (const file of ODL_FILES) {
    it(`${file} parses without GraphQL syntax errors`, () => {
      const source = readOdl(file);
      const schema = parseOdl(source);
      expect(schema).toBeDefined();
    });
  }
});

describe('Supply Chain Domain Pack — Action Manifests', () => {
  const actionFiles = ['create-order.yaml', 'ship-order.yaml', 'receive-shipment.yaml', 'cancel-order.yaml'];

  for (const file of actionFiles) {
    describe(file, () => {
      it('parses without errors', () => {
        const yaml = readAction(file);
        const result = parseActionManifest(yaml);
        expect(result.errors).toEqual([]);
        expect(result.valid).toBe(true);
        expect(result.manifest).toBeDefined();
      });
    });
  }

  describe('create-order.yaml', () => {
    it('has correct action name and structure', () => {
      const result = parseActionManifest(readAction('create-order.yaml'));
      const m = result.manifest!;
      expect(m.action).toBe('CreateOrder');
      expect(m.version).toBe(1);
      expect(m.reversible).toBe(false);
      expect(m.preconditions).toHaveLength(3);
      expect(m.effects).toHaveLength(1);
      expect(m.sideEffects).toHaveLength(1);
      expect(m.rollback!.onSideEffectFailure).toBe('LOG_AND_CONTINUE');
    });

    it('effects have correct types', () => {
      const result = parseActionManifest(readAction('create-order.yaml'));
      const types = result.manifest!.effects.map(e => e.type);
      expect(types).toEqual(['createObject']);
    });
  });

  describe('ship-order.yaml', () => {
    it('has correct action name and structure', () => {
      const result = parseActionManifest(readAction('ship-order.yaml'));
      const m = result.manifest!;
      expect(m.action).toBe('ShipOrder');
      expect(m.version).toBe(1);
      expect(m.reversible).toBe(false);
      expect(m.preconditions).toHaveLength(4);
      expect(m.effects).toHaveLength(2);
      expect(m.sideEffects).toHaveLength(1);
    });

    it('effects have correct types', () => {
      const result = parseActionManifest(readAction('ship-order.yaml'));
      const types = result.manifest!.effects.map(e => e.type);
      expect(types).toEqual(['updateObject', 'createObject']);
    });

    it('creates Shipment object', () => {
      const result = parseActionManifest(readAction('ship-order.yaml'));
      const createObj = result.manifest!.effects.find(e => e.type === 'createObject');
      expect(createObj).toBeDefined();
      if (createObj?.type === 'createObject') {
        expect(createObj.objectType).toBe('Shipment');
      }
    });
  });

  describe('receive-shipment.yaml', () => {
    it('has correct action name and structure', () => {
      const result = parseActionManifest(readAction('receive-shipment.yaml'));
      const m = result.manifest!;
      expect(m.action).toBe('ReceiveShipment');
      expect(m.version).toBe(1);
      expect(m.reversible).toBe(false);
      expect(m.preconditions).toHaveLength(2);
      expect(m.effects).toHaveLength(3);
      expect(m.sideEffects).toHaveLength(2);
    });

    it('effects have correct types', () => {
      const result = parseActionManifest(readAction('receive-shipment.yaml'));
      const types = result.manifest!.effects.map(e => e.type);
      expect(types).toEqual(['updateObject', 'updateObject', 'updateObject']);
    });

    it('includes webhook side effect with retries', () => {
      const result = parseActionManifest(readAction('receive-shipment.yaml'));
      const webhook = result.manifest!.sideEffects.find(se => se.type === 'webhook');
      expect(webhook).toBeDefined();
      expect(webhook!.retries).toBe(3);
    });
  });

  describe('cancel-order.yaml', () => {
    it('has correct action name and structure', () => {
      const result = parseActionManifest(readAction('cancel-order.yaml'));
      const m = result.manifest!;
      expect(m.action).toBe('CancelOrder');
      expect(m.version).toBe(1);
      expect(m.reversible).toBe(false);
      expect(m.preconditions).toHaveLength(2);
      expect(m.effects).toHaveLength(1);
      expect(m.sideEffects).toHaveLength(1);
      expect(m.rollback!.onSideEffectFailure).toBe('LOG_AND_CONTINUE');
    });

    it('effects have correct types', () => {
      const result = parseActionManifest(readAction('cancel-order.yaml'));
      const types = result.manifest!.effects.map(e => e.type);
      expect(types).toEqual(['updateObject']);
    });
  });
});

describe('Supply Chain Domain Pack — pack.yaml manifest', () => {
  it('has all required fields', () => {
    const packYamlPath = resolve(PACK_ROOT, 'pack.yaml');
    const content = readFileSync(packYamlPath, 'utf-8');
    const pack = parseYaml(content) as Record<string, unknown>;

    expect(pack['name']).toBe('supply-chain');
    expect(pack['version']).toBe('0.1.0');
    expect(pack['namespace']).toBe('supply.chain');
  });

  it('does NOT declare NHS facade capabilities (no /fhir or /cdm exposure)', () => {
    const pack = parseYaml(readFileSync(resolve(PACK_ROOT, 'pack.yaml'), 'utf-8')) as Record<string, unknown>;
    const caps = (pack['capabilities'] as string[] | undefined) ?? [];
    expect(caps).not.toContain('fhir');
    expect(caps).not.toContain('cdm');
  });

  it('declares correct dependency on openfoundry.core', () => {
    const packYamlPath = resolve(PACK_ROOT, 'pack.yaml');
    const content = readFileSync(packYamlPath, 'utf-8');
    const pack = parseYaml(content) as Record<string, unknown>;

    const deps = pack['dependencies'] as Record<string, string>;
    expect(deps['openfoundry.core']).toBe('>=1.0.0');
  });

  it('declares correct provides counts', () => {
    const packYamlPath = resolve(PACK_ROOT, 'pack.yaml');
    const content = readFileSync(packYamlPath, 'utf-8');
    const pack = parseYaml(content) as Record<string, unknown>;

    const provides = pack['provides'] as Record<string, number>;
    expect(provides['objectTypes']).toBe(6);
    expect(provides['linkTypes']).toBe(7);
    expect(provides['actionTypes']).toBe(4);
    expect(provides['connectors']).toBe(1);
  });

  it('references all schema files', () => {
    const packYamlPath = resolve(PACK_ROOT, 'pack.yaml');
    const content = readFileSync(packYamlPath, 'utf-8');
    const pack = parseYaml(content) as Record<string, unknown>;

    const schemaFiles = pack['schema'] as string[];
    expect(schemaFiles).toHaveLength(9);
    for (const odlFile of ODL_FILES) {
      expect(schemaFiles).toContain(`schema/${odlFile}`);
    }
  });

  it('references all action files', () => {
    const packYamlPath = resolve(PACK_ROOT, 'pack.yaml');
    const content = readFileSync(packYamlPath, 'utf-8');
    const pack = parseYaml(content) as Record<string, unknown>;

    const actionFiles = pack['actions'] as string[];
    expect(actionFiles).toHaveLength(4);
    expect(actionFiles).toContain('actions/create-order.yaml');
    expect(actionFiles).toContain('actions/ship-order.yaml');
    expect(actionFiles).toContain('actions/receive-shipment.yaml');
    expect(actionFiles).toContain('actions/cancel-order.yaml');
  });
});

describe('Supply Chain Domain Pack — OpenFGA permissions', () => {
  it('permissions file exists with expected types', () => {
    const fgaPath = resolve(PACK_ROOT, 'permissions', 'supply-chain-roles.fga');
    const content = readFileSync(fgaPath, 'utf-8');

    expect(content).toContain('type user');
    expect(content).toContain('type facility');
    expect(content).toContain('type supplier');
    expect(content).toContain('type product');
    expect(content).toContain('type purchase_order');
    expect(content).toContain('type shipment');
    expect(content).toContain('type inventory_record');
  });

  it('purchase_order type has role-aligned permissions', () => {
    const fgaPath = resolve(PACK_ROOT, 'permissions', 'supply-chain-roles.fga');
    const content = readFileSync(fgaPath, 'utf-8');

    expect(content).toContain('define ordered_from: [supplier]');
    expect(content).toContain('define procurement_manager: [user]');
    expect(content).toContain('define supply_chain_admin: [user]');
    expect(content).toContain('define can_create: procurement_manager or supply_chain_admin');
    expect(content).toContain('define can_ship: logistics_manager or supply_chain_admin');
    expect(content).toContain('define can_cancel: procurement_manager or supply_chain_admin');
  });

  it('shipment type has role-aligned permissions', () => {
    const fgaPath = resolve(PACK_ROOT, 'permissions', 'supply-chain-roles.fga');
    const content = readFileSync(fgaPath, 'utf-8');

    expect(content).toContain('define ships_to: [facility]');
    expect(content).toContain('define logistics_manager: [user]');
    expect(content).toContain('define warehouse_manager: [user]');
    expect(content).toContain('define supply_chain_admin: [user]');
    expect(content).toContain('define can_receive: warehouse_manager or logistics_manager or supply_chain_admin');
  });

  it('schema version is 1.1', () => {
    const fgaPath = resolve(PACK_ROOT, 'permissions', 'supply-chain-roles.fga');
    const content = readFileSync(fgaPath, 'utf-8');

    expect(content).toContain('schema 1.1');
  });
});

describe('Supply Chain Domain Pack — Connector config', () => {
  it('erp-jdbc.yaml has expected structure', () => {
    const connPath = resolve(PACK_ROOT, 'connectors', 'erp-jdbc.yaml');
    const content = readFileSync(connPath, 'utf-8');
    const config = parseYaml(content) as Record<string, unknown>;

    expect(config['datasource']).toBe('ERP_Products');
    expect(config['connector']).toBe('jdbc');

    const mapping = config['mapping'] as Record<string, unknown>;
    expect(mapping['objectType']).toBe('Product');

    const sync = config['sync'] as Record<string, unknown>;
    expect(sync['mode']).toBe('OVERLAY');
    expect(sync['writeback']).toBe(false);
  });
});

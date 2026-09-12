#!/usr/bin/env node

/**
 * ODL CLI — validate, diff, apply, generate, rollback commands.
 *
 * Entry point for the `odl` command-line tool.
 */

import { Command } from 'commander';
import { readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseOdl } from '../parser/index.js';
import { validateSchema } from '../validator/index.js';
import { generateGraphQLSchema } from '../codegen/index.js';
import { generateOpenFGASchema } from '../codegen/openfga.js';
import { diff, classify, reverseDiff } from '../diff/index.js';
import { InMemorySchemaRegistry } from '../registry/index.js';
import type { MigrationPlan } from '../registry/types.js';

// ─── Helpers ───

/**
 * Read and concatenate one or more ODL files from a path.
 * If path is a directory, reads all .odl files in it.
 * If path is a file, reads that single file.
 */
function readOdlSource(filePath: string): string {
  const abs = resolve(filePath);
  const stat = statSync(abs);

  if (stat.isDirectory()) {
    const files = readdirSync(abs)
      .filter(f => f.endsWith('.odl'))
      .sort();
    if (files.length === 0) {
      throw new Error(`No .odl files found in directory: ${abs}`);
    }
    return files.map(f => readFileSync(resolve(abs, f), 'utf-8')).join('\n\n');
  }

  return readFileSync(abs, 'utf-8');
}

// ─── Program ───

const program = new Command();

program
  .name('odl')
  .description('Open Foundry ODL (Ontology Definition Language) CLI')
  .version('0.0.1');

// ─── validate ───

program
  .command('validate <path>')
  .description('Parse and validate ODL files. Exit 0 on success, 1 on error.')
  .action((filePath: string) => {
    try {
      const source = readOdlSource(filePath);
      const schema = parseOdl(source);
      const result = validateSchema(schema);

      for (const warning of result.warnings) {
        process.stderr.write(`WARNING [${warning.code}]: ${warning.message}\n`);
      }

      for (const error of result.errors) {
        process.stderr.write(`ERROR [${error.code}]: ${error.message}\n`);
      }

      if (!result.valid) {
        process.stderr.write(
          `\nValidation failed: ${result.errors.length} error(s), ${result.warnings.length} warning(s)\n`,
        );
        process.exitCode = 1;
        return;
      }

      process.stdout.write(
        `Validation passed (${result.warnings.length} warning(s))\n`,
      );
    } catch (err) {
      process.stderr.write(
        `ERROR: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 1;
    }
  });

// ─── diff ───

program
  .command('diff <old-path> <new-path>')
  .description(
    'Show diff between two schema versions with SAFE/COMPATIBLE/BREAKING classification.',
  )
  .action((oldPath: string, newPath: string) => {
    try {
      const oldSource = readOdlSource(oldPath);
      const newSource = readOdlSource(newPath);
      const oldSchema = parseOdl(oldSource);
      const newSchema = parseOdl(newSource);

      const schemaDiff = diff(oldSchema, newSchema);
      const classification = classify(schemaDiff);

      process.stdout.write(`Classification: ${classification}\n\n`);

      if (schemaDiff.additions.length > 0) {
        process.stdout.write(`Additions (${schemaDiff.additions.length}):\n`);
        for (const change of schemaDiff.additions) {
          process.stdout.write(`  + ${formatChange(change)}\n`);
        }
        process.stdout.write('\n');
      }

      if (schemaDiff.modifications.length > 0) {
        process.stdout.write(
          `Modifications (${schemaDiff.modifications.length}):\n`,
        );
        for (const change of schemaDiff.modifications) {
          process.stdout.write(`  ~ ${formatChange(change)}\n`);
        }
        process.stdout.write('\n');
      }

      if (schemaDiff.removals.length > 0) {
        process.stdout.write(`Removals (${schemaDiff.removals.length}):\n`);
        for (const change of schemaDiff.removals) {
          process.stdout.write(`  - ${formatChange(change)}\n`);
        }
        process.stdout.write('\n');
      }

      if (
        schemaDiff.additions.length === 0 &&
        schemaDiff.modifications.length === 0 &&
        schemaDiff.removals.length === 0
      ) {
        process.stdout.write('No changes detected.\n');
      }
    } catch (err) {
      process.stderr.write(
        `ERROR: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 1;
    }
  });

// ─── apply ───

program
  .command('apply <path>')
  .description(
    'Apply schema to registry. Validates first. Rejects BREAKING changes without --force or --migration.',
  )
  .option('--force', 'Force apply even if changes are BREAKING')
  .option('--migration <path>', 'Path to migration plan file (JSON)')
  .action(async (filePath: string, opts: { force?: boolean; migration?: string }) => {
    try {
      const source = readOdlSource(filePath);
      const schema = parseOdl(source);
      const result = validateSchema(schema);

      if (!result.valid) {
        for (const error of result.errors) {
          process.stderr.write(`ERROR [${error.code}]: ${error.message}\n`);
        }
        process.stderr.write('\nValidation failed. Cannot apply.\n');
        process.exitCode = 1;
        return;
      }

      const registry = new InMemorySchemaRegistry();

      let migrationPlan: MigrationPlan | undefined;
      if (opts.force) {
        migrationPlan = {
          description: 'Forced apply via --force flag',
          approved: true,
        };
      } else if (opts.migration) {
        const planSource = readFileSync(resolve(opts.migration), 'utf-8');
        migrationPlan = JSON.parse(planSource) as MigrationPlan;
      }

      const { version } = await registry.applySchema(schema, {
        migrationPlan,
      });

      process.stdout.write(`Schema applied as version ${version}\n`);
    } catch (err) {
      process.stderr.write(
        `ERROR: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 1;
    }
  });

// ─── generate ───

const generate = program
  .command('generate')
  .description('Generate code from ODL schema.');

generate
  .command('graphql <path>')
  .description('Generate GraphQL API schema from ODL.')
  .option('-o, --output <file>', 'Output file path (stdout if not specified)')
  .action((filePath: string, opts: { output?: string }) => {
    try {
      const source = readOdlSource(filePath);
      const schema = parseOdl(source);
      const graphql = generateGraphQLSchema(schema);

      if (opts.output) {
        writeFileSync(resolve(opts.output), graphql, 'utf-8');
        process.stderr.write(`GraphQL schema written to ${opts.output}\n`);
      } else {
        process.stdout.write(graphql);
      }
    } catch (err) {
      process.stderr.write(
        `ERROR: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 1;
    }
  });

generate
  .command('openfga <path>')
  .description('Generate OpenFGA authorization model from ODL.')
  .option('-o, --output <file>', 'Output file path (stdout if not specified)')
  .action((filePath: string, opts: { output?: string }) => {
    try {
      const source = readOdlSource(filePath);
      const schema = parseOdl(source);
      const fga = generateOpenFGASchema(schema);

      if (opts.output) {
        writeFileSync(resolve(opts.output), fga, 'utf-8');
        process.stderr.write(`OpenFGA model written to ${opts.output}\n`);
      } else {
        process.stdout.write(fga);
      }
    } catch (err) {
      process.stderr.write(
        `ERROR: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 1;
    }
  });

// ─── rollback ───

program
  .command('rollback')
  .description('Generate reverse diff migration between schema versions (Section 2.5.1).')
  .requiredOption('--from-version <N>', 'Source version number', parseInt)
  .requiredOption('--to-version <M>', 'Target version number', parseInt)
  .option('--old-path <path>', 'Path to the source version ODL schema')
  .option('--new-path <path>', 'Path to the target version ODL schema')
  .action((opts: { fromVersion: number; toVersion: number; oldPath?: string; newPath?: string }) => {
    try {
      if (!opts.oldPath || !opts.newPath) {
        process.stderr.write(
          'ERROR: --old-path and --new-path are required to compute the reverse diff.\n',
        );
        process.exitCode = 1;
        return;
      }

      const oldSource = readOdlSource(opts.oldPath);
      const newSource = readOdlSource(opts.newPath);
      const oldSchema = parseOdl(oldSource);
      const newSchema = parseOdl(newSource);

      const schemaDiff = diff(oldSchema, newSchema);
      const reversed = reverseDiff(schemaDiff);
      const classification = classify(reversed);

      process.stdout.write(
        `Rollback from version ${opts.fromVersion} to version ${opts.toVersion}\n`,
      );
      process.stdout.write(`Reverse diff classification: ${classification}\n\n`);

      if (reversed.additions.length > 0) {
        process.stdout.write(`Additions (${reversed.additions.length}):\n`);
        for (const change of reversed.additions) {
          process.stdout.write(`  + ${formatChange(change)}\n`);
        }
        process.stdout.write('\n');
      }

      if (reversed.modifications.length > 0) {
        process.stdout.write(
          `Modifications (${reversed.modifications.length}):\n`,
        );
        for (const change of reversed.modifications) {
          process.stdout.write(`  ~ ${formatChange(change)}\n`);
        }
        process.stdout.write('\n');
      }

      if (reversed.removals.length > 0) {
        process.stdout.write(`Removals (${reversed.removals.length}):\n`);
        for (const change of reversed.removals) {
          process.stdout.write(`  - ${formatChange(change)}\n`);
        }
        process.stdout.write('\n');
      }
    } catch (err) {
      process.stderr.write(
        `ERROR: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 1;
    }
  });

// ─── Change formatting ───

import type { SchemaChange } from '../diff/types.js';

function formatChange(change: SchemaChange): string {
  switch (change.kind) {
    case 'type_addition':
      return `${change.typeKind} ${change.name} (added)`;
    case 'type_removal':
      return `${change.typeKind} ${change.name} (removed)`;
    case 'type_modification':
      return `${change.typeKind} ${change.name}: ${change.changes.join(', ')}`;
    case 'field_addition':
      return `${change.typeName}.${change.field.name}: ${change.field.type.name} (added)`;
    case 'field_removal':
      return `${change.typeName}.${change.field.name}: ${change.field.type.name} (removed)`;
    case 'field_modification': {
      const parts: string[] = [`${change.typeName}.${change.fieldName}`];
      if (change.oldType && change.newType) {
        parts.push(`type: ${change.oldType.name} -> ${change.newType.name}`);
      }
      if (change.oldDirectives && change.newDirectives) {
        parts.push('directives changed');
      }
      return parts.join(' ');
    }
    case 'enum_value_addition':
      return `${change.enumName}.${change.valueName} (added)`;
    case 'enum_value_removal':
      return `${change.enumName}.${change.valueName} (removed)`;
    case 'link_modification': {
      const parts: string[] = [`link ${change.linkName}`];
      if (change.oldFrom && change.newFrom) {
        parts.push(`from: ${change.oldFrom} -> ${change.newFrom}`);
      }
      if (change.oldTo && change.newTo) {
        parts.push(`to: ${change.oldTo} -> ${change.newTo}`);
      }
      if (change.oldCardinality && change.newCardinality) {
        parts.push(
          `cardinality: ${change.oldCardinality} -> ${change.newCardinality}`,
        );
      }
      return parts.join(' ');
    }
    default:
      return JSON.stringify(change);
  }
}

// ─── Execute ───

program.parse();

#!/usr/bin/env node
/**
 * CLI entry point for the NHS Acute seed data generator.
 *
 * Usage:
 *   npx tsx src/cli.ts [--output-dir <dir>] [--patients <n>] [--seed <n>]
 */

import { resolve } from 'node:path';
import { generate, DEFAULT_CONFIG, type GeneratorConfig } from './generator.js';
import { writeJson } from './output-json.js';
import { writeSql } from './output-sql.js';

function parseArgs(args: string[]): { outputDir: string; config: GeneratorConfig } {
  const config = { ...DEFAULT_CONFIG };
  let outputDir = resolve(process.cwd(), 'output');

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--output-dir':
        outputDir = resolve(args[++i] ?? '.');
        break;
      case '--patients':
        config.patientCount = Number(args[++i] ?? '0');
        break;
      case '--wards':
        config.wardCount = Number(args[++i] ?? '0');
        break;
      case '--beds':
        config.bedCount = Number(args[++i] ?? '0');
        break;
      case '--consultants':
        config.consultantCount = Number(args[++i] ?? '0');
        break;
      case '--seed':
        config.seed = Number(args[++i] ?? '0');
        break;
      default:
        console.error(`Unknown option: ${arg}`);
        process.exit(1);
    }
  }

  return { outputDir, config };
}

const { outputDir, config } = parseArgs(process.argv.slice(2));

console.log('Generating synthetic NHS acute data...');
console.log(`  Patients: ${config.patientCount}`);
console.log(`  Wards:    ${config.wardCount}`);
console.log(`  Beds:     ${config.bedCount}`);
console.log(`  Consultants: ${config.consultantCount}`);
console.log(`  Seed:     ${config.seed}`);

const data = generate(config);

console.log('\nWriting JSON files...');
const jsonDir = resolve(outputDir, 'json');
const jsonFiles = writeJson(data, jsonDir);
for (const f of jsonFiles) {
  console.log(`  ${f}`);
}

console.log('\nWriting SQL file...');
const sqlDir = resolve(outputDir, 'sql');
const sqlPath = writeSql(data, sqlDir);
console.log(`  ${sqlPath}`);

console.log('\nSummary:');
console.log(`  Patients:          ${data.patients.length}`);
console.log(`  Wards:             ${data.wards.length}`);
console.log(`  Beds:              ${data.beds.length}`);
console.log(`  Consultants:       ${data.consultants.length}`);
console.log(`  DischargeRecords:  ${data.dischargeRecords.length}`);
console.log(`  AdmittedTo links:  ${data.links.admittedTo.length}`);
console.log(`  OccupiesBed links: ${data.links.occupiesBed.length}`);
console.log(`  UnderCareOf links: ${data.links.underCareOf.length}`);
console.log(`  BedInWard links:   ${data.links.bedInWard.length}`);
console.log('\nDone.');

/**
 * JSON output formatter for seed data.
 *
 * Outputs separate JSON files for each entity type, suitable for
 * direct API import via the bulk-load endpoint.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SeedData } from './types.js';

export function writeJson(data: SeedData, outputDir: string): string[] {
  mkdirSync(outputDir, { recursive: true });
  const files: string[] = [];

  const write = (name: string, content: unknown) => {
    const path = resolve(outputDir, `${name}.json`);
    writeFileSync(path, JSON.stringify(content, null, 2));
    files.push(path);
  };

  write('patients', data.patients);
  write('wards', data.wards);
  write('beds', data.beds);
  write('consultants', data.consultants);
  write('discharge-records', data.dischargeRecords);
  write('links-admitted-to', data.links.admittedTo);
  write('links-occupies-bed', data.links.occupiesBed);
  write('links-under-care-of', data.links.underCareOf);
  write('links-bed-in-ward', data.links.bedInWard);

  return files;
}

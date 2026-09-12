/**
 * Provenance-preserving projection from Open Foundry records to CDM shape.
 *
 * The projection is fully driven by the mapping profile (`profile.ts`): no
 * per-resource code. Each projected record carries a `_provenance` envelope so
 * an analyst can see the source type/version and which fields were lossy.
 */

import type {
  CdmMappingProfile,
  CdmResourceMapping,
  CdmRecord,
  CdmProvenance,
} from './types.js';

/** Prefix marking a constant-valued source field (e.g. `__const_ward`). */
const CONST_PREFIX = '__const_';

/**
 * Project a single Open Foundry record into a CDM record using a resource
 * mapping. `source` is an ontology object (or a link flattened to object shape,
 * as the FHIR Encounter path does).
 */
export function projectToCdm(
  source: Record<string, unknown>,
  mapping: CdmResourceMapping,
  profile: CdmMappingProfile,
): CdmRecord {
  const lossyFields: string[] = [];
  const out: Record<string, unknown> = {};

  for (const fm of mapping.fields) {
    let value: unknown;

    if (fm.sourceField.startsWith(CONST_PREFIX)) {
      value = fm.sourceField.slice(CONST_PREFIX.length);
    } else {
      value = source[fm.sourceField];
    }

    if (value === undefined || value === null) {
      // Omit absent optional fields; lossy flag still recorded if declared.
      if (fm.lossy) lossyFields.push(fm.cdmField);
      continue;
    }

    if (fm.enumMap && typeof value === 'string' && value in fm.enumMap) {
      value = fm.enumMap[value];
    }

    out[fm.cdmField] = value;
    if (fm.lossy) lossyFields.push(fm.cdmField);
  }

  const provenance: CdmProvenance = {
    sourceType: mapping.sourceType,
    sourceId: String(source['_id'] ?? out['id'] ?? ''),
    sourceVersion: typeof source['_version'] === 'number' ? (source['_version'] as number) : 0,
    sourceUpdatedAt: typeof source['_updatedAt'] === 'string' ? (source['_updatedAt'] as string) : undefined,
    profileVersion: profile.profileVersion,
    cdmVersion: profile.cdmVersion,
    lossyFields,
  };

  return {
    resourceType: mapping.cdmResource,
    id: String(out['id'] ?? source['_id'] ?? ''),
    ...out,
    _provenance: provenance,
  };
}

/**
 * Find the resource mapping for a given Open Foundry source type.
 * (CDM resource names are not unique — Ward and Bed both map to Location — so
 * lookups are keyed by the source type, which is unique.)
 */
export function findMappingBySourceType(
  profile: CdmMappingProfile,
  sourceType: string,
): CdmResourceMapping | undefined {
  return profile.resources.find(r => r.sourceType === sourceType);
}

/**
 * Find the source type that projects to a given CDM resource name.
 * Returns the first match; ambiguous CDM names (Location) resolve to the
 * first-declared source. Callers that need a specific source should use
 * `findMappingBySourceType`.
 */
export function findMappingByCdmResource(
  profile: CdmMappingProfile,
  cdmResource: string,
): CdmResourceMapping | undefined {
  return profile.resources.find(r => r.cdmResource === cdmResource);
}

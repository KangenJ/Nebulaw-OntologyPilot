/**
 * FDP/CDM compatibility profile — types (Stage 1 item S1.0).
 *
 * The NHS Federated Data Platform Canonical Data Model (CDM) is the
 * interoperability surface FDP standardises on (NHS England DAPB4121,
 * draft-in-progress). Open Foundry does not embed the CDM; instead it ships a
 * declarative *mapping profile* that projects the ODL operational ontology into
 * a CDM-shaped read view, preserving provenance end-to-end.
 *
 * These types describe the profile (the mapping artifact) and the projected
 * record shape (the export view), not the CDM itself.
 */

/** Provenance envelope attached to every projected CDM record. */
export interface CdmProvenance {
  /** Open Foundry object/link type this record was projected from. */
  sourceType: string;
  /** Source `_id`. */
  sourceId: string;
  /** Source `_version` at projection time. */
  sourceVersion: number;
  /** Source `_updatedAt` (ISO), if available. */
  sourceUpdatedAt?: string;
  /** Mapping profile version used. */
  profileVersion: string;
  /** Targeted CDM revision. */
  cdmVersion: string;
  /** CDM fields whose mapping is lossy (semantics differ; see gap register). */
  lossyFields: string[];
}

/** A projected CDM record: resource type + mapped fields + provenance. */
export interface CdmRecord {
  resourceType: string;
  id: string;
  [field: string]: unknown;
  _provenance: CdmProvenance;
}

/** One CDM field, mapped from a single Open Foundry source field. */
export interface CdmFieldMapping {
  /** CDM target field name. */
  cdmField: string;
  /** Open Foundry source field name (`_id`, a property, or a link property). */
  sourceField: string;
  /**
   * Optional enum value remap (OF enum value → CDM coded value).
   * Values absent from the map pass through unchanged.
   */
  enumMap?: Record<string, string>;
  /** True when the mapping drops or approximates CDM semantics. */
  lossy?: boolean;
  /** Human note explaining a transform or a lossy mapping. */
  note?: string;
}

/** Maps one Open Foundry type to one CDM resource. */
export interface CdmResourceMapping {
  /** CDM resource name (the projected `resourceType`). */
  cdmResource: string;
  /** Open Foundry source type (object type or link type name). */
  sourceType: string;
  /** Whether the source is a stored object or a link. */
  sourceKind: 'object' | 'link';
  /** Field-level mappings. */
  fields: CdmFieldMapping[];
  /** Optional note scoping this resource mapping. */
  note?: string;
}

/** A documented gap where ODL and CDM semantics differ. */
export interface CdmGapEntry {
  /** Area of the gap (resource or concept). */
  area: string;
  /** What differs / is missing / is lossy. */
  issue: string;
  /** The safe fallback or remediation. */
  fallback: string;
}

/**
 * The versioned mapping profile: which OF version targets which CDM revision,
 * the operational subset in scope, the per-resource mappings, and the gap
 * register.
 */
export interface CdmMappingProfile {
  /** Profile artifact version (independent of platform/spec versions). */
  profileVersion: string;
  /** Targeted CDM revision label. */
  cdmVersion: string;
  /** Status of the upstream CDM standard at the time of this cut. */
  cdmStatus: string;
  /** Operational subset this profile claims to cover. */
  subset: string[];
  /** Per-resource mappings. */
  resources: CdmResourceMapping[];
  /** Documented gap register. */
  gaps: CdmGapEntry[];
}

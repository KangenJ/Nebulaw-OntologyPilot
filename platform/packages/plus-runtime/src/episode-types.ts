import type { CompiledDefinition, ProjectedValue } from '@openfoundry/plus-contracts';
import type { OntologyObject, StorageProvider,Transaction,RequestContext } from '@openfoundry/spi';
import type { NativeDefinitionRegistry } from './definition-registry.js';
import type { NativeOntologyCatalog, PlusPrincipal } from './ontology-catalog.js';

export interface NativeReference { tenantId:string;type:string;id:string;version:number;schemaRevision:string }
export interface EpisodeSourceRule {
  kind:'OBSERVATION'|'VERIFICATION';
  variable:string;
  sourceType:string;
  sourceLink:string;
  rootSourceLink:string;
  valueField:string;
  eventTimeField:string;
  receivedTimeField:string;
  /** Extra native fields used by the trusted source-qualification adapter. Subject to the same field grants. */
  qualificationFields?:string[];
}
/** Trusted domain-specific bridge directory. Stored and hashed per episode, never accepted from clients. */
export interface EpisodeBinding {
  version:'plus-episode-binding-v1';rootType:string;rootEpisodeLink:string;rootEventLink:string;classificationField:string;
  sources:EpisodeSourceRule[];
}
export type EpisodePermission='episode:open'|'episode:capture'|'episode:snapshot'|'episode:read'|'episode:history'|'source:propose'|'source:review'|'source:read';
export interface EpisodeAccess {
  root:{type:string;id:string};
  fields:Record<string,string[]>;
  sources:NativeReference[];
}
export interface SourceQualification {
  /** This is source-use permission, not a claim that an observation is a true label. */
  allowed:boolean;
  policyHash:string;
  dependenceKey:string;
  verificationMode:'NONE'|'GOLD'|'NOISY';
  learningEligible:boolean;
}
export interface EpisodeRuntimeConfig {
  storage:StorageProvider;catalog:NativeOntologyCatalog;definitions:NativeDefinitionRegistry;tenantId:string;
  authorize:(p:PlusPrincipal,permission:EpisodePermission,access:EpisodeAccess)=>Promise<boolean>;
  bindingFor:(compiled:CompiledDefinition)=>EpisodeBinding|Promise<EpisodeBinding>;
  qualifySource:(p:PlusPrincipal,input:{root:OntologyObject;event:OntologyObject;source:OntologyObject;rule:EpisodeSourceRule})=>Promise<SourceQualification>;
  /** Required for temporal history reads. Historical scope/classification must
   * remain authorized; current-object access alone cannot authorize old scopes. */
  qualifyContextHistory?:(p:PlusPrincipal,input:{root:OntologyObject;versions:OntologyObject[]})=>Promise<{allowed:boolean;policyHash:string;authorizationHash?:string}>;
  /** Mandatory for source-governance commands. Must reject unresolved native-fact/dependent-source effects.
   * This preflight has no write authority; a domain requiring fact repair needs a separate atomic native adapter. */
  assertSourceChangeSafe?:(p:PlusPrincipal,input:{root:OntologyObject;event:OntologyObject;replacement?:OntologyObject;kind:'CORRECTION'|'REVOCATION'})=>Promise<void>;
  /** Trusted native adapter; fingerprint and dependent events are bound into the reviewed proposal.
   * stage must use strict native actions on the supplied transaction and must never commit it. */
  prepareSourceChange?:(p:PlusPrincipal,input:{root:OntologyObject;event:OntologyObject;replacement?:OntologyObject;kind:'CORRECTION'|'REVOCATION'})=>Promise<NativeSourceChangePlan>;
  clock?:()=>number;
  /** Mandatory only for metadata discovery. Full current identity/policy fence. */
  discovery?:{authorizationRevision:(p:PlusPrincipal)=>Promise<string>};
}

export interface NativeSourceChangePlan {
  fingerprint:string;
  invalidatedEvents:OntologyObject[];
  stage:(tx:Transaction,ctx:RequestContext,change:OntologyObject)=>Promise<OntologyObject[]>;
}

export interface SourceChangeInput {
  episodeId:string;kind:'CORRECTION'|'REVOCATION';eventId:string;eventVersion:number;
  replacementId?:string;replacementVersion?:number;reason:string;
}
export interface TypedEpisodeEvent {
  key:string;variable:string;kind:'OBSERVATION'|'VERIFICATION';eventTime:string;receivedAt:string;
  value:ProjectedValue;dependenceKey:string;verificationMode:'NONE'|'GOLD'|'NOISY';
  learningEligible:boolean;
}
export interface EpisodeInput {
  schema:'plus-episode-input-v1';definitionHash:string;bindingHash:string;classification:string;
  startedAt:string;visibleAt:string;targetTime:string;
  /** Only root context/fact values. RULE_DERIVED must be calculated separately;
   * LATENT and OBSERVATION values come through the event stream, never twice. */
  features:Record<string,ProjectedValue>;
  events:TypedEpisodeEvent[];
  predictionReady:false;
}

import { parseOdl, validateSchema, diff, classify, type ParsedSchema, type FieldDefinition } from '@openfoundry/odl';
import { parseActionManifest, type ActionManifest } from '@openfoundry/actions';
import type { OntologySchema, IndexDefinition } from '@openfoundry/spi';
import { canonicalJson, digest } from '@openfoundry/plus-contracts';

export interface OntologyBundleInput { odl: string; manifests: Record<string, unknown>; disabledActions: string[] }
export interface OntologyBundle {
  format: 'plus-ontology-bundle-v1';
  source: OntologyBundleInput;
  parsed: ParsedSchema;
  manifests: Record<string, ActionManifest>;
  disabledActions: string[];
  contentHash: string;
}
const fail = (message: string): never => { throw Object.assign(new Error(`ONTOLOGY_CONTRACT: ${message}`), { code: 'ONTOLOGY_CONTRACT' }); };
const clean = <T>(value: T): T => JSON.parse(canonicalJson(value)) as T;
const compare=(a:string,b:string)=>a===b?0:a<b?-1:1;
const byName = <T extends {name: string}>(values: T[]) => [...values].sort((a,b)=>compare(a.name,b.name));
function normalize(schema: ParsedSchema): ParsedSchema {
  const result=clean(schema);
  for(const kind of ['objectTypes','linkTypes','actionTypes','enums','interfaces','scalars'] as const){
    result[kind].sort((a,b)=>compare(a.name,b.name));
    for(const type of result[kind]){
      if('fields' in type)type.fields=byName(type.fields).map(field=>({...field,directives:[...field.directives].sort((a,b)=>compare(canonicalJson(a),canonicalJson(b)))}));
      if('values' in type)type.values=byName(type.values);
      if('directives' in type)type.directives.sort((a,b)=>compare(canonicalJson(a),canonicalJson(b)));
      if('interfaces' in type)type.interfaces.sort();
    }
  }
  return result;
}
export function buildOntologyBundle(input: OntologyBundleInput): OntologyBundle {
  if(!input || Object.keys(input).some(k=>!['odl','manifests','disabledActions'].includes(k)) || typeof input.odl!=='string'
    || Buffer.byteLength(input.odl)>524288 || !Array.isArray(input.disabledActions) || !input.manifests || typeof input.manifests!=='object' || Array.isArray(input.manifests))fail('bounded ODL, manifests and explicit disabled actions required');
  const parsed=normalize(parseOdl(input.odl));
  const names=new Set<string>();
  for(const types of [parsed.objectTypes,parsed.linkTypes,parsed.actionTypes,parsed.enums,parsed.interfaces,parsed.scalars])for(const type of types){
    if(names.has(type.name))fail('ambiguous type '+type.name);names.add(type.name);
    if('fields' in type && new Set(type.fields.map(f=>f.name)).size!==type.fields.length)fail('duplicate field '+type.name);
  }
  const validation=validateSchema(parsed);if(!validation.valid)fail(validation.errors.map(e=>e.message).join('; '));
  if(new Set(input.disabledActions).size!==input.disabledActions.length || input.disabledActions.some(x=>typeof x!=='string'))fail('invalid disabled action list');
  const disabledActions=[...input.disabledActions].sort();
  const manifests:Record<string,ActionManifest>={};
  for(const [name,raw] of Object.entries(input.manifests)){
    if(!parsed.actionTypes.some(t=>t.name===name) || disabledActions.includes(name))fail('manifest is unknown or disabled: '+name);
    const result=parseActionManifest(canonicalJson(raw),parsed);
    if(!result.valid || !result.manifest || result.manifest.action!==name)fail('invalid manifest: '+name);
    manifests[name]=clean(result.manifest!);
  }
  if(disabledActions.some(name=>!parsed.actionTypes.some(t=>t.name===name)))fail('unknown disabled action');
  for(const action of parsed.actionTypes)if(!manifests[action.name]&&!disabledActions.includes(action.name))fail('missing manifest: '+action.name);
  const contentHash=digest({parsed,manifests,disabledActions});
  return {format:'plus-ontology-bundle-v1',source:clean(input),parsed,manifests,disabledActions,contentHash};
}

/** Same native storage projection as schema-loader; full semantics remain in persisted ODL. */
export function ontologyStorageSchema(bundle: OntologyBundle, version: number): OntologySchema {
  const stored=(field:FieldDefinition)=>!field.directives.some(d=>['primary','computed','link'].includes(d.kind));
  return clean({version,objectTypes:bundle.parsed.objectTypes.map(t=>{
    const indexes:IndexDefinition[]=[];
    for(const f of t.fields.filter(stored)){
      if(f.directives.some(d=>d.kind==='unique'))indexes.push({field:f.name,indexType:'BTREE',unique:true});
      else if(f.directives.some(d=>d.kind==='indexed'))indexes.push({field:f.name,indexType:'BTREE'});
      if(f.directives.some(d=>d.kind==='searchable'))indexes.push({field:f.name,indexType:'FULLTEXT'});
    }
    return {name:t.name,properties:t.fields.filter(stored).map(f=>({name:f.name,type:f.type.name,required:f.type.nonNull})),...(indexes.length?{indexes}:{})};
  }),linkTypes:bundle.parsed.linkTypes.map(t=>({name:t.name,fromType:t.from,toType:t.to,cardinality:t.cardinality,
    ...(t.fields.length?{properties:t.fields.map(f=>({name:f.name,type:f.type.name,required:f.type.nonNull}))}:{})}))});
}
export function storageSchemaDigest(schema: OntologySchema): string {
  return digest({...schema,objectTypes:byName(schema.objectTypes).map(t=>({...t,properties:byName(t.properties),indexes:[...(t.indexes??[])].sort((a,b)=>compare(canonicalJson(a),canonicalJson(b)))})),
    linkTypes:byName(schema.linkTypes).map(t=>({...t,properties:byName(t.properties??[])}))});
}
/** One exact additive control migration. Caller still needs an immutable,
 * trusted source/target allowlist and the native independent publication flow. */
export function assertRecipeRuleDependencyMigration(previous:OntologyBundle,next:OntologyBundle):void {
  const name='PlusRecipeRuleSpecification';
  const expected=normalize(parseOdl('type PlusRecipeRuleSpecification @linkType(from:"PlusModelRecipe",to:"PlusRuleSpecification",cardinality:MANY_TO_MANY) { id: ID! @primary }')).linkTypes[0];
  const actual=next.parsed.linkTypes.find(l=>l.name===name),restored=structuredClone(next.parsed);
  restored.linkTypes=restored.linkTypes.filter(l=>l.name!==name);
  if(previous.parsed.linkTypes.some(l=>l.name===name)||!actual||digest(actual)!==digest(expected)
    ||digest(restored)!==digest(previous.parsed)||digest(next.manifests)!==digest(previous.manifests)
    ||digest(next.disabledActions)!==digest(previous.disabledActions))fail('recipe rule dependency migration scope');
}

/** Exact additive component lineage edge. No business/action/control rewrite. */
export function assertRecipeComponentDependencyMigration(previous:OntologyBundle,next:OntologyBundle):void {
  const name='PlusRecipeComponentDecision';
  const expected=normalize(parseOdl('type PlusRecipeComponentDecision @linkType(from:"PlusModelRecipe",to:"PlusModelDecision",cardinality:MANY_TO_MANY) { id: ID! @primary }')).linkTypes[0];
  const actual=next.parsed.linkTypes.find(l=>l.name===name),restored=structuredClone(next.parsed);
  restored.linkTypes=restored.linkTypes.filter(l=>l.name!==name);
  if(previous.parsed.linkTypes.some(l=>l.name===name)||!actual||digest(actual)!==digest(expected)
    ||digest(restored)!==digest(previous.parsed)||digest(next.manifests)!==digest(previous.manifests)
    ||digest(next.disabledActions)!==digest(previous.disabledActions))fail('recipe component dependency migration scope');
}

/** Exact additive lineage edge for a joint belief. No other schema, manifest,
 * business field or action change can be carried through this approval. */
export function assertBeliefRuleDependencyMigration(previous:OntologyBundle,next:OntologyBundle):void {
  const name='PlusBeliefRuleSpecification';
  const expected=normalize(parseOdl('type PlusBeliefRuleSpecification @linkType(from:"PlusBeliefSnapshot",to:"PlusRuleSpecification",cardinality:MANY_TO_ONE) { id: ID! @primary }')).linkTypes[0];
  const actual=next.parsed.linkTypes.find(l=>l.name===name),restored=structuredClone(next.parsed);
  restored.linkTypes=restored.linkTypes.filter(l=>l.name!==name);
  if(previous.parsed.linkTypes.some(l=>l.name===name)||!actual||digest(actual)!==digest(expected)
    ||digest(restored)!==digest(previous.parsed)||digest(next.manifests)!==digest(previous.manifests)
    ||digest(next.disabledActions)!==digest(previous.disabledActions))fail('belief rule dependency migration scope');
}

export function assertPublishableChange(previous: OntologyBundle, next: OntologyBundle, approvedBridgeMigration=false): void {
  const delta=diff(previous.parsed,next.parsed);
  // A virtual @link field is resolved through the relationship store, not a required stored column.
  const storedDelta={...delta,additions:delta.additions.filter(c=>!(c.kind==='field_addition'&&c.field.directives.some(d=>d.kind==='link')))};
  if(classify(storedDelta)==='BREAKING')fail('breaking change requires a separately implemented data migration; publication refused');
  // Required additions need actual backfill, not merely a @default schema promise.
  if(storedDelta.additions.some(c=>c.kind==='field_addition'&&c.field.type.nonNull))fail('required field addition needs backfill');
  for(const kind of ['objectTypes','linkTypes','actionTypes','enums'] as const){
    for(const type of previous.parsed[kind].filter(t=>t.name.startsWith('Plus'))){
      if(digest(next.parsed[kind].find(t=>t.name===type.name)??null)!==digest(type))fail('protected Plus control definition changed');
    }
    for(const type of next.parsed[kind].filter(t=>t.name.startsWith('Plus'))){
      if(!previous.parsed[kind].some(t=>t.name===type.name))fail('new Plus control definitions require an engineering migration');
    }
  }
  // A bridge is control-plane topology even when its domain-facing name is not Plus*.
  const controlLink=(link:{name:string;from:string;to:string})=>[link.name,link.from,link.to].some(name=>name.startsWith('Plus'));
  for(const link of next.parsed.linkTypes.filter(controlLink)){
    const old=previous.parsed.linkTypes.find(old=>old.name===link.name);
    if(old?digest(old)!==digest(link):!approvedBridgeMigration)fail('control-plane bridges require an engineering migration');
  }
  for(const [name,manifest] of Object.entries(next.manifests)){
    if(digest(previous.manifests[name]??null)===digest(manifest))continue;
    if(manifest.sideEffects.length||manifest.effects.some(e=>e.type==='recordConsent'))fail('new/changed action is not transaction-only');
    if(previous.disabledActions.includes(name))fail('retired action cannot be re-enabled by ontology editing');
    const action=next.parsed.actionTypes.find(t=>t.name===name)!;
    if(action.fields.some(f=>f.directives.some(d=>d.kind==='param')&&next.parsed.objectTypes.some(t=>t.name===f.type.name&&t.name.startsWith('Plus'))))fail('control-plane parameters require an engineering migration');
    for(const effect of manifest.effects){
      if(effect.type==='createObject'&&effect.objectType.startsWith('Plus'))fail('control-plane effects are not domain actions');
      if((effect.type==='createLink'||effect.type==='deleteLink')&&next.parsed.linkTypes.some(link=>link.name===effect.linkType&&controlLink(link)))fail('control-plane links are not domain actions');
      if(effect.type==='updateObject'&&effect.target.includes('.'))fail('nested mutation targets require an explicit reviewed adapter');
      if(effect.type==='createLink'&&(effect.from.includes('.')||effect.to.includes('.')))fail('nested link endpoints require an explicit reviewed adapter');
      if(effect.type==='deleteLink'&&(effect.filter.from?.includes('.')||effect.filter.to?.includes('.')))fail('nested link deletion requires an explicit reviewed adapter');
    }
  }
}

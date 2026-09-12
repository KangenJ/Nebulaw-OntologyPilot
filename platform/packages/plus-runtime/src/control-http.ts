import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuditRecord, DateTime } from '@openfoundry/spi';
import { NativeOntologyCatalog, type OntologyCatalogConfig, type PlusPrincipal } from './ontology-catalog.js';
import { NativeDefinitionRegistry, type DefinitionRegistryConfig } from './definition-registry.js';
import type { OntologyBundleInput } from './ontology-bundle.js';
import type { NativeEpisodeRuntime } from './episode-runtime.js';
import { ContractError } from '@openfoundry/plus-contracts';

export interface PlusControlHttpConfig {
  storage: OntologyCatalogConfig['storage'];
  tenantId: string;
  /** Must consult the current credential store; no caller-supplied principal or policy. */
  authenticate: (request: IncomingMessage) => PlusPrincipal | Promise<PlusPrincipal>;
  authorizeOntology: OntologyCatalogConfig['authorize'];
  authorizeDefinition: DefinitionRegistryConfig['authorize'];
  policyFor: DefinitionRegistryConfig['policyFor'];
  definitionKeys?: DefinitionRegistryConfig['listKeys'];
  definitionCandidateFor?: DefinitionRegistryConfig['candidateFor'];
  recordFailure: (record: AuditRecord) => Promise<unknown>;
  /** Optional server-owned domain adapter. There is no generic manifest/body execution endpoint. */
  executeTask?: (request:{action:string;input:unknown;principal:PlusPrincipal;key:string;catalog:NativeOntologyCatalog;reauthenticate:()=>Promise<void>})=>Promise<unknown>;
  /** Explicit server-owned browse grants; never infer from action or model access. */
  readObject?: (request:{type:string;id:string;principal:PlusPrincipal;catalog:NativeOntologyCatalog;reauthenticate:()=>Promise<void>})=>Promise<unknown>;
  listObjects?: (request:{type:string;query:Record<string,string>;principal:PlusPrincipal;catalog:NativeOntologyCatalog;reauthenticate:()=>Promise<void>})=>Promise<unknown>;
  readLinks?: (request:{type:string;id:string;query:Record<string,string>;principal:PlusPrincipal;catalog:NativeOntologyCatalog;reauthenticate:()=>Promise<void>})=>Promise<unknown>;
  analyzeObject?: (request:{type:string;id:string;query:Record<string,string>;principal:PlusPrincipal;catalog:NativeOntologyCatalog;reauthenticate:()=>Promise<void>})=>Promise<unknown>;
  readGovernance?: (request:{mode:string;query:Record<string,string>;principal:PlusPrincipal;catalog:NativeOntologyCatalog;reauthenticate:()=>Promise<void>})=>Promise<unknown>;
  createEpisodeRuntime?: (request:{catalog:NativeOntologyCatalog;definitions:NativeDefinitionRegistry;reauthenticate:()=>Promise<void>})=>Pick<NativeEpisodeRuntime,'open'|'capture'|'snapshot'|'readStream'|'readSnapshot'|'proposeSourceChange'|'reviewSourceChange'|'readSourceChange'> & Partial<Pick<NativeEpisodeRuntime,'readTemporalInput'|'listForRoot'>>;
}
const PREFIX='/api/plus/v2';
const LIMIT=1_048_576;
const fail=(code:string):never=>{throw Object.assign(new Error(code),{code});};
const send=(res:ServerResponse,status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
function object(value:unknown,fields:string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!fields.includes(k)))fail('INVALID_INPUT');
  return value as Record<string,unknown>;
}
function version(value:unknown):number{if(!Number.isSafeInteger(value)||Number(value)<1)fail('INVALID_VERSION');return value as number;}
function decision(value:unknown):'APPROVE'|'REJECT'{if(value!=='APPROVE'&&value!=='REJECT')fail('INVALID_DECISION');return value as 'APPROVE'|'REJECT';}
async function body(req:IncomingMessage):Promise<unknown>{
  if(req.headers['content-encoding']&&req.headers['content-encoding']!=='identity')fail('UNSUPPORTED_ENCODING');
  if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']??''))fail('JSON_REQUIRED');
  if(Number(req.headers['content-length']??0)>LIMIT){req.resume();fail('BODY_TOO_LARGE');}
  const chunks:Buffer[]=[];let bytes=0;
  for await(const chunk of req){const buffer=Buffer.from(chunk);bytes+=buffer.length;if(bytes>LIMIT)fail('BODY_TOO_LARGE');chunks.push(buffer);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;}catch{fail('INVALID_JSON');}
}
function publicError(error:unknown):{code:string;status:number}{
  const raw=(error as {code?:unknown})?.code;
  const code=typeof raw==='string'&&/^[A-Z][A-Z0-9_]{0,90}$/.test(raw)?raw:'PLUS_INTERNAL_ERROR';
  // Compiler refusals are typed input/authority failures, not host outages.
  // Only the safe code is returned; private paths and validation text stay out.
  if(error instanceof ContractError)return {code,status:/FORBIDDEN|ACCESS_POLICY/.test(code)?403:400};
  const taskStatus=(error as {status?:number})?.status;
  if(code.startsWith('TASK_')&&taskStatus&&[400,403,404,409,503].includes(taskStatus))return {code,status:taskStatus};
  if(code==='UNAUTHENTICATED')return {code,status:401};
  if(code==='IDENTITY_CONFIGURATION_UNAVAILABLE')return {code,status:503};
  if(/^GOVERNANCE_.*(?:CONFIGURATION|NOT_CONFIGURED)/.test(code))return {code,status:503};
  if(code.endsWith('FORBIDDEN'))return {code,status:403};
  if(['EPISODE_BINDING_NOT_CONFIGURED','EPISODE_DISCOVERY_NOT_CONFIGURED'].includes(code))return {code,status:503};
  if(code==='CONTEXT_HISTORY_ADAPTER_REQUIRED'||code==='CONTEXT_HISTORY_VERSION_GAP')return {code,status:503};
  if(/^CONTEXT_HISTORY_(?:INSUFFICIENT|CHANGE_TIME_REQUIRED|RECEIPT_REVERSED|TIME_ORDER|PARTIAL_TIME|INITIAL_CLOCK_CHANGED|INITIAL_REENTRY)$/.test(code))return {code,status:409};
  if(code==='CONTEXT_HISTORY_VERSION_LIMIT')return {code,status:400};
  if(code==='EPISODE_INPUT_SUSPENDED')return {code,status:409};
  if(/^COMPOSITION_(?:BRANCH_REQUIRED|BACKEND_UNSUPPORTED|CROSS_BRANCH_DEPENDENCY|INPUT_ROLE|TRANSITION_STRUCTURE|OBSERVATION_STRUCTURE|RULE_DEPENDENCY|UNBOUND_DERIVED|UNMODELED_OBSERVATION|PROJECTION_MISMATCH)$/.test(code))return {code,status:409};
  if(code==='EPISODE_SOURCE_SUPERSEDED'||/SOURCE_CHANGE_.*(?:NOT_HEAD|FAMILY_MISMATCH)/.test(code))return {code,status:409};
  if(code==='SOURCE_CHANGE_LIMIT')return {code,status:400};
  if(/^EPISODE_.*(?:REVOKED|CLASSIFICATION_CHANGED|FUTURE_EVENT|START_IN_FUTURE|TARGET_OUTSIDE_WINDOW|OBSERVATION_NOT_A_LABEL|SOURCE_LIMIT)$/.test(code))return {code,status:409};
  if(code==='BODY_TOO_LARGE')return {code,status:413};
  if(code==='NOT_FOUND'||code==='OBJECT_READ_NOT_FOUND'||code==='DEFINITION_CANDIDATE_NOT_FOUND'||code.endsWith('REVISION_NOT_FOUND'))return {code,status:404};
  if(code==='OBJECT_READ_POLICY_INVALID')return {code,status:503};
  if(code==='OBJECT_LINK_SCAN_LIMIT')return {code,status:409};
  if(/CONFLICT|STALE|INDEPENDENT_REVIEW|NON_MONOTONIC/.test(code))return {code,status:409};
  if(/NOT_INITIALIZED|NOT_PUBLISHED|INTEGRITY|DRIFT|GUARD_REQUIRED|ATOMIC_SCHEMA_REQUIRED|AUTH_NOT_CONFIGURED|COLLECTION_LIMIT/.test(code))return {code,status:503};
  if(/INVALID|REQUIRED|UNSUPPORTED|ONTOLOGY_CONTRACT|FIELD_NOT_FOUND|TYPE_NOT_FOUND|SIZE_LIMIT|NO_CHANGE/.test(code))return {code,status:400};
  return {code:'PLUS_INTERNAL_ERROR',status:500};
}

/** Opt-in native HTTP surface. Does not install schema, adopt a baseline, start a server or run a model. */
export function createPlusControlHandler(config:PlusControlHttpConfig){
  return async(req:IncomingMessage,res:ServerResponse):Promise<boolean>=>{
    const path=(req.url??'').split('?')[0]!;
    if(path!==PREFIX&&!path.startsWith(PREFIX+'/'))return false;
    const traceId=randomUUID();let principal:PlusPrincipal|undefined;
    try{
      const authenticated=await config.authenticate(req);
      if(!authenticated?.id||authenticated.tenantId!==config.tenantId||!Array.isArray(authenticated.roles))fail('FORBIDDEN');
      principal=authenticated;
      const identity=structuredClone(principal);
      // Re-read token on every service authorization, including immediately before commit.
      const reauthenticate=async()=>{
        const now=await config.authenticate(req);
        if(now.id!==identity.id||now.tenantId!==identity.tenantId||JSON.stringify([...now.roles].sort())!==JSON.stringify([...identity.roles].sort()))fail('UNAUTHENTICATED');
      };
      const catalog=new NativeOntologyCatalog({storage:config.storage,tenantId:config.tenantId,authorize:async(p,permission)=>{await reauthenticate();const allowed=await config.authorizeOntology(p,permission);await reauthenticate();return allowed;}});
      const registry=new NativeDefinitionRegistry({storage:config.storage,catalog,tenantId:config.tenantId,
        ...(config.definitionKeys?{listKeys:async(p:PlusPrincipal)=>{await reauthenticate();const keys=await config.definitionKeys!(p);await reauthenticate();return keys;}}:{}),
        ...(config.definitionCandidateFor?{candidateFor:async(p:PlusPrincipal,key:string)=>{await reauthenticate();const value=await config.definitionCandidateFor!(p,key);await reauthenticate();return value;}}:{}),
        authorize:async(p,permission,key)=>{await reauthenticate();const allowed=await config.authorizeDefinition(p,permission,key);await reauthenticate();return allowed;},
        policyFor:async(p,key)=>{await reauthenticate();const policy=await config.policyFor(p,key);await reauthenticate();return policy;}});
      const route=path.slice(PREFIX.length);
      const governanceView=route.match(/^\/governance\/(host|audit|jobs|object)$/);
      const objectRecord=route.match(/^\/objects\/([A-Za-z][A-Za-z0-9_]{0,127})\/([A-Za-z0-9_-]{1,256})$/);
      const objectLinks=route.match(/^\/objects\/([A-Za-z][A-Za-z0-9_]{0,127})\/([A-Za-z0-9_-]{1,256})\/links$/);
      const objectAnalysis=route.match(/^\/objects\/([A-Za-z][A-Za-z0-9_]{0,127})\/([A-Za-z0-9_-]{1,256})\/analysis$/);
      const objectList=route.match(/^\/objects\/([A-Za-z][A-Za-z0-9_]{0,127})$/);
      const ontologyRevision=route.match(/^\/ontology\/revisions\/([A-Za-z0-9_-]+)(?:\/(validate|review))?$/);
      const mechanism=route.match(/^\/definitions\/([A-Za-z][A-Za-z0-9_.-]{0,127})\/(published|revisions|composition|parameters|candidate|previews)(?:\/([A-Za-z0-9_-]+)(?:\/(validate|review))?)?$/);
      const taskAction=route.match(/^\/actions\/(NativeImportTaskMatter|NativeImportTaskRule|NativeRegisterInvestigationTask|NativeRecordTaskObservation|NativeVerifyTaskObservation|NativeSetTaskPriority)$/);
      const episodeCapture=route.match(/^\/episodes\/([A-Za-z0-9_-]+)\/captures$/);
      const episodeRecord=route.match(/^\/(streams|snapshots)\/([A-Za-z0-9_-]+)$/);
      const temporalRecord=route.match(/^\/snapshots\/([A-Za-z0-9_-]+)\/temporal-input$/);
      const sourceChange=route.match(/^\/source-changes\/([A-Za-z0-9_-]+)(?:\/(review))?$/);
      let result:unknown;
      if(req.method==='GET'&&route==='/me'){
        // Identity only, not workspace/model readiness. Whitelist fields so a
        // provider's private metadata can never become a client credential.
        result={id:identity.id,tenantId:identity.tenantId,roles:[...identity.roles]};
      }else if(req.method==='GET'&&governanceView){
        if(!config.readGovernance)fail('GOVERNANCE_FORBIDDEN');if((req.url??'').length>4096)fail('GOVERNANCE_INVALID_INPUT');
        const params=new URLSearchParams((req.url??'').split('?').slice(1).join('?')),query:Record<string,string>=Object.create(null);
        for(const [key,value]of params){if(Object.hasOwn(query,key))fail('GOVERNANCE_INVALID_INPUT');query[key]=value;}
        result=await config.readGovernance!({mode:governanceView[1]!,query,principal:identity,catalog,reauthenticate});
      }else if(req.method==='GET'&&objectAnalysis){
        if(!config.analyzeObject)fail('OBJECT_READ_FORBIDDEN');if((req.url??'').length>4096)fail('OBJECT_READ_INVALID_INPUT');
        const params=new URLSearchParams((req.url??'').split('?').slice(1).join('?')),query:Record<string,string>={};
        for(const [key,value]of params){if(!['linkType','direction','field','mode'].includes(key)||Object.hasOwn(query,key))fail('OBJECT_READ_INVALID_INPUT');query[key]=value;}
        result=await config.analyzeObject!({type:objectAnalysis[1]!,id:objectAnalysis[2]!,query,principal:identity,catalog,reauthenticate});
      }else if(req.method==='GET'&&objectLinks){
        if(!config.readLinks)fail('OBJECT_LINK_FORBIDDEN');
        if((req.url??'').length>4096)fail('OBJECT_READ_INVALID_INPUT');
        const params=new URLSearchParams((req.url??'').split('?').slice(1).join('?')),query:Record<string,string>={};
        for(const [key,value]of params){if(!['linkType','direction','limit','after'].includes(key)||Object.hasOwn(query,key))fail('OBJECT_READ_INVALID_INPUT');query[key]=value;}
        result=await config.readLinks!({type:objectLinks[1]!,id:objectLinks[2]!,query,principal:identity,catalog,reauthenticate});
      }else if(req.method==='GET'&&objectRecord){
        if(!config.readObject)fail('OBJECT_READ_FORBIDDEN');
        result=await config.readObject!({type:objectRecord[1]!,id:objectRecord[2]!,principal:identity,catalog,reauthenticate});
      }else if(req.method==='GET'&&objectList){
        if(!config.listObjects)fail('OBJECT_READ_FORBIDDEN');
        if((req.url??'').length>4096)fail('OBJECT_READ_INVALID_INPUT');
        const params=new URLSearchParams((req.url??'').split('?').slice(1).join('?')),query:Record<string,string>={};
        for(const [key,value] of params){
          if(!['limit','after','field','operator','value'].includes(key)||Object.hasOwn(query,key))fail('OBJECT_READ_INVALID_INPUT');
          query[key]=value;
        }
        result=await config.listObjects!({type:objectList[1]!,query,principal:identity,catalog,reauthenticate});
      }else if(req.method==='GET'&&route==='/episodes'){
        const query=new URL(req.url!,'http://127.0.0.1').searchParams;
        if([...query.keys()].sort().join(',')!=='definitionKey,rootId,rootType')fail('EPISODE_INVALID_INPUT');
        if(!config.createEpisodeRuntime)fail('EPISODE_DISCOVERY_NOT_CONFIGURED');
        const episodes=config.createEpisodeRuntime!({catalog,definitions:registry,reauthenticate});if(!episodes.listForRoot)fail('EPISODE_DISCOVERY_NOT_CONFIGURED');
        result=await episodes.listForRoot!(query.get('definitionKey')!,{type:query.get('rootType')!,id:query.get('rootId')!},identity);
      }else if(config.createEpisodeRuntime&&req.method==='GET'&&temporalRecord){
        const episodes=config.createEpisodeRuntime({catalog,definitions:registry,reauthenticate});
        if(!episodes.readTemporalInput)fail('CONTEXT_HISTORY_ADAPTER_REQUIRED');
        result=await episodes.readTemporalInput!(temporalRecord[1]!,identity);
      }else if(config.createEpisodeRuntime&&((req.method==='POST'&&route==='/source-changes')||sourceChange)){
        const episodes=config.createEpisodeRuntime({catalog,definitions:registry,reauthenticate});
        if(req.method==='POST'&&route==='/source-changes'){
          const key=req.headers['idempotency-key'];if(typeof key!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(key))fail('IDEMPOTENCY_REQUIRED');
          const input=object(await body(req),['episodeId','kind','eventId','eventVersion','replacementId','replacementVersion','reason']);
          result=await episodes.proposeSourceChange(input as unknown as Parameters<NativeEpisodeRuntime['proposeSourceChange']>[0],identity,key as string);
        }else if(req.method==='POST'&&sourceChange?.[2]==='review'){
          const input=object(await body(req),['expectedVersion','decision','reason']);
          result=await episodes.reviewSourceChange(sourceChange[1]!,version(input.expectedVersion),decision(input.decision),input.reason as string,identity);
        }else if(req.method==='GET'&&sourceChange&&!sourceChange[2])result=await episodes.readSourceChange(sourceChange[1]!,identity);
        else fail('NOT_FOUND');
      }else if(config.createEpisodeRuntime&&((req.method==='POST'&&(route==='/episodes'||route==='/snapshots'||episodeCapture))||(req.method==='GET'&&episodeRecord))){
        const episodes=config.createEpisodeRuntime({catalog,definitions:registry,reauthenticate});
        if(req.method==='GET'&&episodeRecord)result=episodeRecord[1]==='streams'?await episodes.readStream(episodeRecord[2]!,identity):await episodes.readSnapshot(episodeRecord[2]!,identity);
        else{
          const key=req.headers['idempotency-key'];if(typeof key!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(key))fail('IDEMPOTENCY_REQUIRED');
          const fields=route==='/episodes'?['definitionKey','rootId','startedAt']:route==='/snapshots'?['streamId','targetTime']:[];
          const input=object(await body(req),fields);if(fields.some(name=>typeof input[name]!=='string'||!String(input[name]).trim()))fail('INVALID_INPUT');
          result=route==='/episodes'?await episodes.open(input as {definitionKey:string;rootId:string;startedAt:string},identity,key as string):route==='/snapshots'?
            await episodes.snapshot(input as {streamId:string;targetTime:string},identity,key as string):await episodes.capture(episodeCapture![1]!,identity,key as string);
        }
      }else if(req.method==='POST'&&taskAction&&config.executeTask){
        const key=req.headers['idempotency-key'];if(typeof key!=='string')fail('IDEMPOTENCY_REQUIRED');
        result=await config.executeTask({action:taskAction[1]!,input:await body(req),principal:identity,key:key as string,catalog,reauthenticate});
      }else if(req.method==='GET'&&route==='/definition-candidates'){
        if((req.url??'').includes('?'))fail('INVALID_INPUT');result=await registry.listCandidates(identity);
      }else if(req.method==='GET'&&route==='/definitions'){
        if((req.url??'').includes('?'))fail('DEFINITION_INVALID_QUERY');
        result=await registry.listAvailable(identity);
      }else if(req.method==='GET'&&route==='/ontology')result=await catalog.read(identity);
      else if(req.method==='GET'&&route==='/ontology/revisions')result=await catalog.listRevisions(identity);
      else if(req.method==='GET'&&ontologyRevision&&!ontologyRevision[2])result=await catalog.readRevision(ontologyRevision[1]!,identity);
      else if(req.method==='POST'&&route==='/ontology/property-previews'){
        const input=object(await body(req),['objectType','field','valueType','expectedParentHash']);
        result=await catalog.previewOptionalProperty(input as unknown as Parameters<NativeOntologyCatalog['previewOptionalProperty']>[0],identity);
      }
      else if(req.method==='POST'&&route==='/ontology/structure-previews'){
        const input=object(await body(req),['kind','name','properties','from','to','cardinality','expectedParentHash']);
        result=await catalog.previewStructure(input,identity);
      }
      else if(req.method==='POST'&&route==='/ontology/revisions'){
        const input=object(await body(req),['odl','manifests','disabledActions','expectedParentHash']);
        const {expectedParentHash,...source}=input;
        if(expectedParentHash!==undefined&&(typeof expectedParentHash!=='string'||!expectedParentHash))fail('INVALID_INPUT');
        const key=req.headers['idempotency-key'];if(typeof key!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(key))fail('IDEMPOTENCY_REQUIRED');
        result=await catalog.submit(source as unknown as OntologyBundleInput,identity,key as string,expectedParentHash as string|undefined);
      }else if(req.method==='POST'&&ontologyRevision&&ontologyRevision[2]){
        const operation=ontologyRevision[2],input=object(await body(req),operation==='validate'?['expectedVersion']:['expectedVersion','decision','reason']);
        result=operation==='validate'?await catalog.validate(ontologyRevision[1]!,version(input.expectedVersion),identity):
          await catalog.review(ontologyRevision[1]!,version(input.expectedVersion),decision(input.decision),input.reason as string,identity);
      }else if(mechanism){
        const [,key,collection,id,operation]=mechanism;
        if(['candidate','previews'].includes(collection!)&&(req.url??'').includes('?'))fail('INVALID_INPUT');
        if(req.method==='GET'&&collection==='published'&&!id)result=await registry.requirePublished(key!,identity);
        else if(req.method==='GET'&&collection==='candidate'&&!id)result=await registry.readCandidate(key!,identity);
        else if(req.method==='POST'&&collection==='previews'&&!id){
          const raw=await body(req);if((raw as {key?:unknown})?.key!==key)fail('INVALID_DEFINITION_KEY');result=await registry.preview(raw,identity);
        }
        else if(req.method==='GET'&&collection==='parameters'&&!id)result=await registry.readParameterManifest(key!,identity);
        else if(req.method==='GET'&&collection==='composition'&&!id)result=await registry.previewComposition(key!,identity);
        else if(collection==='revisions'&&req.method==='GET'&&!operation)result=id?await registry.readRevision(key!,id,identity):await registry.listRevisions(key!,identity);
        else if(collection==='revisions'&&req.method==='POST'&&!id){
          const raw=await body(req);
          if(raw&&typeof raw==='object'&&Object.hasOwn(raw,'definition')){
            const input=object(raw,['definition','expectedCompiledHash']);if((input.definition as {key?:unknown})?.key!==key||typeof input.expectedCompiledHash!=='string')fail('INVALID_DEFINITION_KEY');
            result=await registry.submit(input.definition,identity,input.expectedCompiledHash as string);
          }else{if((raw as {key?:unknown})?.key!==key)fail('INVALID_DEFINITION_KEY');result=await registry.submit(raw,identity);}
        }else if(collection==='revisions'&&req.method==='POST'&&id&&operation){
          const input=object(await body(req),operation==='validate'?['expectedVersion']:['expectedVersion','decision']);
          result=operation==='validate'?await registry.validate(key!,id,version(input.expectedVersion),identity):
            await registry.review(key!,id,version(input.expectedVersion),decision(input.decision),identity);
        }else fail('NOT_FOUND');
      }else fail('NOT_FOUND');
      // No response can reveal a read that finished after credential revocation.
      await reauthenticate();
      send(res,200,{data:result,traceId});
    }catch(error){
      let exposed=publicError(error);
      if(principal&&req.method==='POST'){
        try{await config.recordFailure({id:'audit_'+randomUUID(),tenantId:principal.tenantId,timestamp:new Date().toISOString() as DateTime,traceId,
          actor:{id:principal.id,type:'user',roles:[...principal.roles]},operation:{type:'action',actionType:'PlusControlRequest'},
          detail:{result:exposed.status===401||exposed.status===403?'denied':'error',denialReason:exposed.code}});}
        catch{exposed={code:'AUDIT_UNAVAILABLE',status:503};}
      }
      // Never return submitted ODL, evidence, credentials, policy content or internal exception messages.
      send(res,exposed.status,{error:{code:exposed.code,message:exposed.code},traceId});
    }
    return true;
  };
}

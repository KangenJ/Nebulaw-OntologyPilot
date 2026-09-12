import { readFileSync,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '@openfoundry/plus-contracts';
import { createNativeStorage } from '../../../apps/lwm-demo/src/native-storage.mjs';
import { NativeOntologyCatalog,NativeDefinitionRegistry,NativeEpisodeRuntime,buildOntologyBundle,ontologyStorageSchema,sourceEventDigest } from '../dist/index.js';
import { fixture as contractFixture } from '../../plus-contracts/tests/fixture.mjs';

export const ctx={tenantId:'episode-synthetic-test'};
export const principal={id:'analyst',tenantId:ctx.tenantId,roles:['investigator']};
const author={...principal,id:'author',roles:['data_reviewer']},owner={...principal,id:'owner',roles:['model_owner']};
export const start='2026-01-01T00:00:00.000Z';
export const at=minutes=>new Date(Date.parse(start)+minutes*60000).toISOString();
const metadata=readFileSync(new URL('../../../domain-packs/plus-core/schema/metadata.odl',import.meta.url),'utf8');
// A three-state, non-legal native ontology. Only isolated synthetic data; no real-label claim.
const business=`enum MachineState { READY BUSY OFFLINE UNKNOWN }
type Machine @objectType {
 id: ID! @primary actual: MachineState! status: String! priority: Int!
 createdAt: DateTime! receivedAt: DateTime! classification: PlusClassification!
 signals: [SensorReading!]! @link(type:"RootSignal",direction:OUTBOUND)
}
type SensorReading @objectType { id: ID! @primary report: MachineState @sensitive observedAt: DateTime! receivedAt: DateTime! evidence: String @sensitive }
type StatusCheck @objectType { id: ID! @primary result: MachineState! observedAt: DateTime! receivedAt: DateTime! evidence: String @sensitive }
type RootSignal @linkType(from:"Machine",to:"SensorReading",cardinality:ONE_TO_MANY) { id: ID! @primary }
type RootCheck @linkType(from:"Machine",to:"StatusCheck",cardinality:ONE_TO_MANY) { id: ID! @primary }
type MachineEpisode @linkType(from:"Machine",to:"PlusEpisode",cardinality:ONE_TO_MANY) { id: ID! @primary }
type MachineEvent @linkType(from:"Machine",to:"PlusEvent",cardinality:ONE_TO_MANY) { id: ID! @primary }
type EventReading @linkType(from:"PlusEvent",to:"SensorReading",cardinality:MANY_TO_ONE) { id: ID! @primary }
type EventCheck @linkType(from:"PlusEvent",to:"StatusCheck",cardinality:MANY_TO_ONE) { id: ID! @primary }
type VerifyObject @actionType(permission:"can_review") { task: Machine! @param expectedVersion: Int! @param note: String! @param }
`;
export async function episodeFixture(t,{secondary=false}={}){
 const c=contractFixture({root:'Machine',signal:'SensorReading',enumName:'MachineState',states:['READY','BUSY','OFFLINE']});
 const report=c.definition.variables.find(v=>v.key==='report');report.nullable=true;report.unknownValues=['UNKNOWN'];report.support=['READY','BUSY','OFFLINE'];
 c.context.policy.fieldSemantics['SensorReading.report'].knowledgeOnlyValues=['UNKNOWN'];
 if(secondary){const variable=structuredClone(c.definition.variables.find(v=>v.key==='state'));variable.key='secondary';variable.source.field='secondary';c.definition.variables.push(variable);
  const transition=c.definition.modules.find(m=>m.kind==='TRANSITION');transition.inputs.push('secondary');transition.outputs.push('secondary');
  c.context.policy.readableFields.push('Machine.secondary');c.context.policy.fieldSemantics['Machine.secondary']=structuredClone(c.context.policy.fieldSemantics['Machine.actual']);}
 const baseline={odl:metadata+(secondary?business.replace('actual: MachineState!','actual: MachineState! secondary: MachineState!'):business),manifests:{VerifyObject:c.manifest},disabledActions:[]};
 const dir=mkdtempSync(join(tmpdir(),'plus-episode-test-')),path=join(dir,'platform.sqlite'),handles=[];
 const openStorage=()=>{const s=createNativeStorage(path);handles.push(s);return s;};
 t.after(()=>{handles.forEach(s=>s.close());rmSync(dir,{recursive:true,force:true});});
 const storage=openStorage();await storage.applySchema(ctx,ontologyStorageSchema(buildOntologyBundle(baseline),1));
 const catalog=new NativeOntologyCatalog({storage,tenantId:ctx.tenantId,authorize:async()=>true});await catalog.adoptInstalledBaseline(baseline,owner);
 const definitions=new NativeDefinitionRegistry({storage,catalog,tenantId:ctx.tenantId,authorize:async()=>true,policyFor:async()=>structuredClone(c.context.policy)});
 const draft=await definitions.submit(c.definition,author),valid=await definitions.validate(c.definition.key,draft._id,draft._version,author);
 await definitions.review(c.definition.key,valid._id,valid._version,'APPROVE',owner);
 const schemaHash=(await catalog.read(principal)).bundle.contentHash;
 const binding={version:'plus-episode-binding-v1',rootType:'Machine',rootEpisodeLink:'MachineEpisode',rootEventLink:'MachineEvent',classificationField:'classification',sources:[
  {kind:'OBSERVATION',variable:'report',sourceType:'SensorReading',sourceLink:'EventReading',rootSourceLink:'RootSignal',valueField:'report',eventTimeField:'observedAt',receivedTimeField:'receivedAt'},
  {kind:'VERIFICATION',variable:'state',sourceType:'StatusCheck',sourceLink:'EventCheck',rootSourceLink:'RootCheck',valueField:'result',eventTimeField:'observedAt',receivedTimeField:'receivedAt'},
 ]};
 if(secondary)binding.sources.push({...binding.sources.find(s=>s.variable==='state'),variable:'secondary'});
 let now=Date.parse(at(1)),authorize=async()=>true,qualify=async(p,{event,rule})=>({allowed:true,policyHash:digest('synthetic-policy-v1'),dependenceKey:digest([event.sourceSystem,event.sourceRecordId]),verificationMode:rule.kind==='VERIFICATION'?'GOLD':'NONE',learningEligible:rule.kind==='VERIFICATION'});
 const config={storage,catalog,definitions,tenantId:ctx.tenantId,bindingFor:()=>structuredClone(binding),clock:()=>now,authorize:(...args)=>authorize(...args),qualifySource:(...args)=>qualify(...args),
  assertSourceChangeSafe:async(_p,{root})=>{if(root.classification!=='SYNTHETIC'||root.actual!=='UNKNOWN')throw Object.assign(new Error('SOURCE_CHANGE_NATIVE_FACT_REPAIR_REQUIRED'),{code:'SOURCE_CHANGE_NATIVE_FACT_REPAIR_REQUIRED'});}};
 const runtime=new NativeEpisodeRuntime(config);
 const root=await storage.createObject(ctx,'Machine',{actual:'UNKNOWN',...(secondary?{secondary:'UNKNOWN'}:{}),status:'REGISTERED',priority:2,createdAt:start,receivedAt:start,classification:'SYNTHETIC'});
 const ref=o=>({tenantId:ctx.tenantId,type:o._type,id:o._id,version:o._version,schemaRevision:schemaHash});
 const add=async({kind='OBSERVATION',value='READY',minute=1,received=minute,origin='record-'+minute,revision='1',rootId=root._id,stageJournal,variable='state'}={})=>{
  const check=kind==='VERIFICATION',sourceType=check?'StatusCheck':'SensorReading';
  const tx=await storage.beginTransaction(ctx);
  try{
   const source=await tx.createObject(sourceType,{[check?'result':'report']:value,observedAt:at(minute),receivedAt:at(received),evidence:'PRIVATE_RAW_EVIDENCE'});
   await tx.createLink(check?'RootCheck':'RootSignal',rootId,source._id);
   const props={sourceKey:digest(['synthetic-machine-sensor',origin,revision]),eventKind:kind,classification:'SYNTHETIC',sourceSystem:'synthetic-machine-sensor',sourceRecordId:origin,sourceRevision:revision,
    sourceReference:ref(source),eventTime:at(minute),ingestedAt:at(received),variableKey:check?(variable==='secondary'?'secondary':'actual'):'report',typedValue:value===null?{kind:'MISSING'}:value==='UNKNOWN'?{kind:'UNKNOWN',marker:'UNKNOWN'}:{kind:'VALUE',value},revoked:false};
   const event=await tx.createObject('PlusEvent',{...props,contentHash:sourceEventDigest(props)});
   await tx.createLink('MachineEvent',rootId,event._id);await tx.createLink(check?'EventCheck':'EventReading',event._id,source._id);
   await stageJournal?.(tx,{source,event});
   await tx.commit();return {source,event};
  }catch(e){await tx.rollback();throw e;}
 };
 const begin=()=>runtime.open({definitionKey:c.definition.key,rootId:root._id,startedAt:start},principal,'episode-1');
 return {storage,catalog,definitions,definition:c.definition,config,runtime,root,binding,add,begin,ref,openStorage,path,
  setTime:minute=>now=Date.parse(at(minute)),setAuthorize:fn=>authorize=fn,setQualify:fn=>qualify=fn,getQualify:()=>qualify,
  rows:type=>storage.queryObjects(ctx,type,{and:[]})};
}

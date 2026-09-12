// Isolated SYNTHETIC native Task data. This fixture seeds native source records with
// an explicit clock; it does not claim canonical action execution or real labels.
import { readFileSync,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '@openfoundry/plus-contracts';
import { loadDomainPacks } from '../../api/dist/schema-loader.js';
import { NativeOntologyCatalog,NativeDefinitionRegistry,buildOntologyBundle,ontologyStorageSchema,sourceEventDigest } from '../dist/index.js';
import { createNativeStorage } from '../../../apps/lwm-demo/src/native-storage.mjs';
import { createTaskEpisodeRuntime } from '../../../apps/lwm-demo/src/task-episode.mjs';
import { createTaskLearningServices,taskGroupingPolicyHash } from '../../../apps/lwm-demo/src/task-learning.mjs';
import { buildTaskVerificationInput } from '../../../domain-packs/lwm-plus/mechanisms/task-verification.mjs';
import { buildTaskPriorityInput } from '../../../domain-packs/lwm-plus/mechanisms/task-priority.mjs';
import { buildTaskSourceGovernanceInput } from '../../../domain-packs/lwm-plus/mechanisms/task-source-governance.mjs';
import { taskMechanismDefinition,taskTimedMechanismDefinition } from '../../../domain-packs/lwm-plus/mechanisms/task-mechanism.mjs';
import { buildTaskRulesInput,taskRuleMechanismDefinition,taskInvestigationMechanismDefinition } from '../../../domain-packs/lwm-plus/mechanisms/task-rules.mjs';
import { observationRecipe,observationEstimatorId } from '../../../../services/plus-engine/native-fit-verifier.mjs';

export const ctx={tenantId:'task-learning-test'};
export const trainer={id:'task-trainer',tenantId:ctx.tenantId,roles:['trainer']},reviewer={id:'task-reviewer',tenantId:ctx.tenantId,roles:['data_reviewer']},owner={id:'task-owner',tenantId:ctx.tenantId,roles:['model_owner']};
export const at=n=>new Date(Date.parse('2026-01-01T00:00:00.000Z')+n*60000).toISOString();
export async function taskLearningFixture(t,{timedPriority=false,initializePriority=false,withRules=false,withTransitionAction=false,sourceGovernanceCel}={}){
  if(withTransitionAction&&!withRules)throw new Error('INVESTIGATION_RULE_CONTEXT_REQUIRED');
  if(withRules&&!timedPriority)throw new Error('TIMED_RULE_CONTEXT_REQUIRED');
  if(initializePriority&&!timedPriority)throw new Error('TIMED_PRIORITY_REQUIRED');
  const loaded=await loadDomainPacks(undefined,['core','lwm-demo','lwm-plus','plus-core']);
  const odl=loaded.packInfos.flatMap(pack=>pack.manifest.schema.map(path=>readFileSync(join(pack.packDir,path),'utf8'))).join('\n');
  let baseline=buildTaskVerificationInput({odl,manifests:{},disabledActions:loaded.parsed.actionTypes.map(a=>a.name)});
  if(timedPriority)baseline=buildTaskPriorityInput(baseline,{initializePriority});
  if(withRules)baseline=buildTaskRulesInput(baseline);
  if(sourceGovernanceCel)baseline=buildTaskSourceGovernanceInput(baseline);
  const bundle=buildOntologyBundle(baseline);
  const dir=mkdtempSync(join(tmpdir(),'plus-task-learning-')),path=join(dir,'platform.sqlite'),handles=[];
  const open=()=>{const s=createNativeStorage(path);handles.push(s);return s;};
  t.after(()=>{handles.forEach(s=>s.close());rmSync(dir,{recursive:true,force:true});});
  const storage=open();await storage.applySchema(ctx,ontologyStorageSchema(bundle,1));
  const people=new Map([trainer,reviewer,owner].map(p=>[p.id,structuredClone(p)]));
  const identities={authorizationRevision:()=>digest([...people.values()].sort((a,b)=>a.id.localeCompare(b.id))),
    resolvePrincipal:async id=>{const p=people.get(id);if(!p)throw Object.assign(new Error('IDENTITY_FORBIDDEN'),{code:'IDENTITY_FORBIDDEN'});return structuredClone(p);}};
  const catalog=new NativeOntologyCatalog({storage,tenantId:ctx.tenantId,authorize:async p=>people.has(p.id)});await catalog.adoptInstalledBaseline(baseline,owner);
  const mechanism=withTransitionAction?taskInvestigationMechanismDefinition():withRules?taskRuleMechanismDefinition():timedPriority?taskTimedMechanismDefinition():taskMechanismDefinition(),definitions=new NativeDefinitionRegistry({storage,catalog,tenantId:ctx.tenantId,authorize:async p=>people.has(p.id),policyFor:async()=>mechanism.policy});
  const draft=await definitions.submit(mechanism.definition,reviewer),valid=await definitions.validate(mechanism.definition.key,draft._id,draft._version,reviewer);
  await definitions.review(mechanism.definition.key,valid._id,valid._version,'APPROVE',owner);
  const {compiled}=await definitions.requirePublished(mechanism.definition.key,trainer);
  const method={policyRef:'independent-task-check-v1',mode:'GOLD',allowedRoles:['data_reviewer'],classifications:['SYNTHETIC']};
  const types=Object.fromEntries(['InvestigationTask','Observation','TaskCompletionVerification'].map(name=>[name,{read:bundle.parsed.objectTypes.find(t=>t.name===name).fields
    .filter(f=>!f.directives.some(d=>['primary','computed','link'].includes(d.kind))).map(f=>f.name)}]));
  const collectionPolicyHash=digest('synthetic-task-prospective-collection'),populationPolicyHash=digest('synthetic-task-one-report-per-root');
  const protocol={version:'plus-cohort-v1',key:'task-round-1',collectionPolicyHash,definitionHash:compiled.definitionHash,variable:'completion',classification:'SYNTHETIC',partition:'TRAIN',
    inputVisibleFrom:at(1),inputVisibleUntil:at(2),labelReceivedFrom:at(3),labelReceivedUntil:at(7),approvalUntil:at(9),expectedSampleCount:1,minimumSamples:1,minimumCoverage:1};
  const policy={taskDomain:{enabled:true,workspaceClassifications:{synthetic:'SYNTHETIC',other:'SYNTHETIC'},sources:{'task-source':{classification:'SYNTHETIC',channelKeys:['report'],allowedRoles:['investigator']}},
    verificationMethods:{independent:method},episodeGrants:[trainer,reviewer,owner].map(p=>({principalId:p.id,workspaces:['synthetic','other'],permissions:['episode:open','episode:capture','episode:snapshot','episode:read',...(timedPriority?['episode:history']:[])],types:structuredClone(types)}))},
    taskLearning:{version:'plus-task-learning-v1',enabled:true,partition:{version:'plus-partition-v1',seed:'task-software-fixture',groupingPolicyHash:taskGroupingPolicyHash,boundaries:[6000,7500,9000,10000]},groups:[],
      feedback:['synthetic','other'].map(workspace=>({workspace,policy:{version:'plus-feedback-policy-v1',key:'task-feedback-'+workspace,collectionPolicyHash,minimumMaturityMs:0,classifications:['SYNTHETIC'],variables:['completion']}})),
      cohorts:[{workspace:'synthetic',protocol}],recipes:[{workspace:'synthetic',key:'task.observation',policy:{version:'plus-recipe-policy-v1',id:'task-fit-purpose',engineIds:[observationEstimatorId],classifications:['SYNTHETIC'],
        collectionPolicyHashes:[collectionPolicyHash],populationPolicyHashes:[populationPolicyHash],scopeKeys:[compiled.definition.scope.key]}}],
      grants:[trainer,reviewer,owner].map(p=>({principalId:p.id,requiredRoles:p.roles,workspaces:['synthetic','other'],
        permissions:['partition:reserve','partition:read','feedback:propose','feedback:review','feedback:read','cohort:propose','cohort:review','cohort:read','dataset:freeze','dataset:inspect','dataset:FIT','dataset:VALIDATE','dataset:FINAL_EVALUATE','recipe:draft','recipe:review','recipe:revoke','recipe:read','recipe:use'],
        protocolKeys:[protocol.key],recipeKeys:['task.observation'],types:{InvestigationTask:{read:['workspaceKey']},Matter:{read:['workspaceKey']}}}))}};
  let now=2;
  if(sourceGovernanceCel){
    for(const grant of policy.taskDomain.episodeGrants)grant.permissions.push('source:propose','source:review','source:read');
    policy.taskDomain.sourceGovernance={enabled:true,grants:[{principalId:owner.id,workspaces:['synthetic'],
      actions:['NativeInvalidateTaskVerification','NativeRebuildTaskCompletion'],types:{
        TaskCompletionVerification:{write:['validity','revokedAt','revokedBy','revocationReason']},
        InvestigationTask:{write:['actualCompletion','actualCompletionAt','actualCompletionRecordedAt']},
        TaskCompletionRepair:{create:true,write:['repairKey','previousTaskVersion','result','targetTime','basisStatus','basis','recordedAt','recordedBy','classification','reason']}}}]};
  }
  const options={storage,catalog,definitions,tenantId:ctx.tenantId,identities,loadPolicy:()=>policy,clock:()=>Date.parse(at(now)),...(sourceGovernanceCel?{cel:sourceGovernanceCel}:{})};
  const services=createTaskLearningServices(options),episodes=createTaskEpisodeRuntime({...options,reauthenticate:async()=>{}});
  let sequence=0;
  const root=async(workspace='synthetic',existingMatter,startedMinute=0)=>{
    const n=++sequence,matter=existingMatter??await storage.createObject(ctx,'Matter',{workspaceKey:workspace,matterNumber:'SYNTHETIC-'+n,title:'Isolated task grouping',jurisdiction:'TEST',status:'NEW',currentState:'EVIDENCE_COMPLETE',riskBand:'LOW',owner:'fixture',openedAt:at(0)});
    if(!policy.taskLearning.groups.some(g=>g.matterId===matter._id))policy.taskLearning.groups.push({matterId:matter._id,workspace,aliases:[]});
    const task=await storage.createObject(ctx,'InvestigationTask',{workspaceKey:workspace,taskNumber:'TASK-'+n,title:'Synthetic input',status:'OPEN',priority:'LOW',assignee:'fixture',instructions:'not real business data',dueAt:at(startedMinute+20),createdAt:at(startedMinute),receivedAt:at(startedMinute),registeredBy:'fixture',actualCompletion:'UNKNOWN',dataClassification:'SYNTHETIC'});
    await storage.createLink(ctx,'MatterTask',matter._id,task._id);return {matter,task};
  };
  const reference=o=>({tenantId:ctx.tenantId,type:o._type,id:o._id,version:o._version,schemaRevision:bundle.contentHash});
  const source=async(task,{observation,result='DONE',received=observation?4:1,record='report-'+sequence,eventMinute=1,stageJournal}={})=>{
    const tx=await storage.beginTransaction(ctx),check=!!observation;
    const eventTime=check?observation.observedAt:at(eventMinute);
    try{
      const object=check?await tx.createObject('TaskCompletionVerification',{verificationKey:'check-'+task._id+'-'+received,taskVersion:task._version,observationVersion:observation._version,result,targetTime:eventTime,recordedAt:at(received),recordedBy:reviewer.id,methodKey:'independent',mode:'GOLD',evidence:'SYNTHETIC independent fixture label',classification:'SYNTHETIC'}):
        await tx.createObject('Observation',{workspaceKey:task.workspaceKey,observationNumber:record,title:record,kind:'SYSTEM_SIGNAL',source:'task-source',summary:'SYNTHETIC report',confidence:0,verified:false,recordedBy:'independent-observer',observedAt:eventTime,receivedAt:at(received),reportedCompletion:result,channelKey:'report',sourceSystem:'task-source',sourceRecordId:record,sourceRevision:'1',sourceEventKey:digest([ctx.tenantId,'task-source',record,'1']),sourceContentHash:digest([record,result]),dataClassification:'SYNTHETIC'});
      await tx.createLink(check?'TaskCompletionCheck':'TaskObservation',task._id,object._id);if(check)await tx.createLink('ObservationCompletionCheck',observation._id,object._id);
      const props={sourceKey:check?digest([ctx.tenantId,'native.task-verification',object._id,'1']):object.sourceEventKey,eventKind:check?'VERIFICATION':'OBSERVATION',classification:'SYNTHETIC',sourceSystem:check?'native.task-verification':'task-source',
        sourceRecordId:check?object._id:record,sourceRevision:'1',sourceReference:reference(object),eventTime,ingestedAt:at(received),variableKey:check?'actualCompletion':'reportedCompletion',typedValue:{kind:'VALUE',value:result},
        ...(check?{verification:{mode:'GOLD',policyRef:method.policyRef,policyHash:digest(method),observation:reference(observation),verifiedBy:reviewer.id,targetTime:eventTime}}:{})};
      const event=await tx.createObject('PlusEvent',{...props,contentHash:sourceEventDigest(props),revoked:false});
      await tx.createLink('TaskPlusEvent',task._id,event._id);await tx.createLink(check?'EventSourceTaskVerification':'EventSourceObservation',event._id,object._id);
      await stageJournal?.(tx,{object,event,task});
      await tx.commit();return {object,event};
    }catch(e){await tx.rollback();throw e;}
  };
  const capture=async(episode,key,targetMinute=1)=>{const stream=await episodes.capture(episode._id,trainer,'capture-'+key);return episodes.snapshot({streamId:stream.record._id,targetTime:at(targetMinute)},trainer,'snapshot-'+key);};
  const initial=await root(),report=await source(initial.task),episode=await episodes.open({definitionKey:mechanism.definition.key,rootId:initial.task._id,startedAt:at(0)},trainer,'open-initial');
  const input=await capture(episode,'initial');
  // Fix the software fixture partition before enrolling or recording any label.
  for(let i=0;i<100;i++){const seed='synthetic-task-seed-'+i,bucket=parseInt(digest([seed,ctx.tenantId,['task-matter-v1',digest(['synthetic',initial.matter._id])]]).slice(0,8),16)%10000;
    if(bucket<6000){policy.taskLearning.partition.seed=seed;break;}}
  const contexts=compiled.variables.find(v=>v.key==='priority').support.map(priority=>({priority})),states=['DONE','NOT_DONE'].map(completion=>({completion}));
  const outcomes=[{kind:'VALUE',value:'DONE'},{kind:'VALUE',value:'NOT_DONE'},{kind:'UNKNOWN',marker:'UNKNOWN'},{kind:'MISSING'}];
  const baselineModel={schema:'plus-finite-spec-v1',clock:'LOGICAL_STEP',initialContextInputs:[],contextSupport:{priority:contexts.map(c=>c.priority)},hypotheses:[{key:'synthetic-task-identity',prior:1,
    initial:contexts.map(context=>({context,probabilities:states.map(state=>({state,p:0.5}))})),transition:['WAIT',...compiled.definition.actions.map(a=>'ACTION:'+a.key)].flatMap(control=>contexts.flatMap(context=>states.map(from=>({control,context,from,probabilities:states.map(state=>({state,p:state.completion===from.completion?1:0}))})))),
    channels:[{variable:'report',kind:'OBSERVATION',mode:'NONE',rows:contexts.flatMap(context=>states.map(state=>({context,state,probabilities:outcomes.map(value=>({value,p:0.25}))})))}]}]};
  const fitting={schema:'plus-observation-fit-config-v1',targetVariable:'completion',observationVariable:'report',classification:'SYNTHETIC',bindingHash:input.compiledInput.bindingHash,
    collectionPolicyHash,populationPolicyHash,trainingProtocolHashes:[digest(protocol)],smoothingAlpha:1,minimumSamples:1,minimumPerState:0,minimumCoverage:1,sampling:'ONE_TARGET_REPORT_PER_ENTITY'};
  return {storage,path,open,catalog,definitions,options,services,episodes,people,policy,protocol,compiled,mechanism,bundle,root,source,capture,initial,report,episode,input,
    advance:n=>now=n,recipe:()=>observationRecipe(compiled,baselineModel,fitting)};
}

import {digest} from '@openfoundry/plus-contracts';
import {NativeActionRequests} from '../dist/index.js';
import {taskLearningFixture,ctx,at} from './task-learning-fixture.mjs';
import {nativeCelFixture} from '../../../../services/plus-engine/native-cel-fixture.mjs';
import {createTaskActionRequestInspector,createTaskActionRequestExecution} from '../../../apps/lwm-demo/src/task-action-request.mjs';
export {ctx};

// Actual native Task schema/objects/relationships, independent native approval,
// fixed native action adapter, real CEL and SQLite atomic effects. Scenario/model
// admission is an explicit upstream test adapter, NOT a complete-model proof.
export async function actionExecutionFixture(t){
  const f=await taskLearningFixture(t),cel=await nativeCelFixture(t);
  const investigator={id:'native-action-investigator',tenantId:ctx.tenantId,roles:['investigator']};
  const reviewer={id:'native-action-reviewer',tenantId:ctx.tenantId,roles:['case_reviewer']};
  for(const p of [investigator,reviewer])f.people.set(p.id,structuredClone(p));
  const state={allowed:true,modelAllowed:true,epoch:0,materialReads:0,stages:0,valid:true};
  const body={scenarioKey:digest('explicit-test-scenario'),classification:'SYNTHETIC',plans:{input:{key:'task.action',episodeId:f.episode._id},createdAt:at(10)},
    predictions:{options:[{key:'REQUEST_VERIFICATION'}],executionAuthorized:false,businessFactsWritten:false},utilityVersion:'explicit-test-utility'};
  const scenario=await f.storage.createObject(ctx,'PlusScenarioRun',{...body,contentHash:digest(body),readiness:'READY'});
  const authority=async p=>{const current=f.people.get(p.id);if(!current||digest(current)!==digest(p))throw Error('FIXTURE_IDENTITY_FORBIDDEN');
    return digest({people:[...f.people],allowed:state.allowed,modelAllowed:state.modelAllowed,epoch:state.epoch});};
  const domain={storage:f.storage,catalog:f.catalog,tenantId:ctx.tenantId,cel:cel.client,
    authorize:async(p,operation)=>{await authority(p);return state.allowed&&[investigator.id,reviewer.id].includes(p.id)
      &&operation.action==='NativeRegisterInvestigationTask'&&(!operation.resources.some(r=>r.operation==='create'||r.writeFields?.length)||p.id===investigator.id);},
    taskClassificationFor:async p=>{await authority(p);return 'SYNTHETIC';}};
  const config={storage:f.storage,tenantId:ctx.tenantId,authorizationRevision:authority,clock:()=>Date.now(),
    authorize:async(p,permission,scope)=>{await authority(p);return state.allowed&&scope.key==='task.action'&&scope.episodeId===f.episode._id
      &&scope.scenarioId===scenario._id&&scope.actionName==='NativeRegisterInvestigationTask'
      &&(permission==='action-request:decide'?p.id===reviewer.id:permission==='action-request:read'?[reviewer.id,investigator.id].includes(p.id):p.id===investigator.id);},
    scenarios:{read:async(id,p)=>{state.materialReads++;await authority(p);if(!state.modelAllowed)throw Error('FIXTURE_MODEL_WITHDRAWN');
      return {record:await f.storage.getObject(ctx,'PlusScenarioRun',id),nativeAdmissionChecked:true};}},
    inspectAction:createTaskActionRequestInspector(domain),prepareExecution:createTaskActionRequestExecution(domain),resolvePrincipal:async id=>structuredClone(f.people.get(id))};
  const requests=new NativeActionRequests(config),input={scenarioId:scenario._id,optionKey:'REQUEST_VERIFICATION',actionName:'NativeRegisterInvestigationTask',
    params:{matter:f.initial.matter._id,expectedVersion:f.initial.matter._version,taskNumber:'ATOMIC-FOLLOWUP',title:'Follow-up verification',priority:'HIGH',assignee:'fixture-investigator',instructions:'Request actual verification, not a known outcome',dueAt:'2027-01-01T00:00:00Z'},
    reason:'Explicit test action intent',requestKey:'native-action-original'};
  const proposal=await requests.submit(input,investigator),approved=await requests.decide({requestId:proposal.id,expectedVersion:proposal.version,decision:'APPROVE',reason:'Independent test review'},reviewer);
  const execute={requestId:approved.id,expectedVersion:approved.version};
  const rows=type=>f.storage.queryObjects(ctx,type,{and:[]},{limit:1000});
  const guard={assertCurrent:async()=>{if(!state.valid)throw Error('TEST_ACTION_LEASE_LOST');},stage:async(tx,result,ref)=>{
    state.stages++;if(result.id!==ref.id||result.version!==ref.version||result.receipt.executedBy!==investigator.id)throw Error('TEST_ACTION_BINDING');
    await tx.createObject('PlusExecution',{executionKey:'test-action-commit-'+state.stages,kind:'ACTION_EXECUTION_TEST_RECEIPT',inputReadSet:{testOnly:true},principalId:investigator.id,status:'SUCCEEDED',attempts:1,resultReference:{result,ref}});
  }};
  return {...f,cel,state,config,requests,investigator,reviewer,scenario,execute,guard,rows};
}

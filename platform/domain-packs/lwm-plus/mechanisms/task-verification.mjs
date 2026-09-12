import { readFileSync } from 'node:fs';
import { extendOdl } from '../../../packages/odl/dist/index.js';

const receipt=(action,type,binding)=>({type:'createObject',objectType:'NativeCommandReceipt',properties:{commandKey:'params.commandKey',commandHash:'params.commandHash',actorId:'actor.id',actionName:action,resultType:type,resultId:binding+'._id',traceId:'params.traceId',createdAt:'now'}});
const link=(linkType,from,to,properties)=>({type:'createLink',linkType,from,to,...(properties?{properties}:{})});
const manifest=(action,role,preconditions,effects)=>({action,version:1,reversible:false,preconditions:[{expr:`actor.hasRole('${role}')`,error:'Required role missing'},...preconditions.map(expr=>({expr,error:'Task verification precondition failed'}))],effects,sideEffects:[]});

export function taskVerificationManifests(){
  return {
    NativeRegisterInvestigationTask:manifest('NativeRegisterInvestigationTask','investigator',['matter._version == params.expectedVersion'],[
      {type:'createObject',objectType:'InvestigationTask',as:'newTask',properties:{workspaceKey:'matter.workspaceKey',taskNumber:'params.taskNumber',title:'params.title',status:'OPEN',priority:'params.priority',assignee:'params.assignee',instructions:'params.instructions',dueAt:'params.dueAt',createdAt:'now',receivedAt:'now',registeredBy:'actor.id',actualCompletion:'UNKNOWN',dataClassification:'params.classification'}},
      link('MatterTask','matter','newTask',{linkedAt:'now'}),receipt('NativeRegisterInvestigationTask','InvestigationTask','newTask'),
    ]),
    NativeRecordTaskObservation:manifest('NativeRecordTaskObservation','investigator',['task._version == params.expectedVersion'],[
      {type:'createObject',objectType:'Observation',as:'newReport',properties:{workspaceKey:'task.workspaceKey',observationNumber:'params.sourceEventKey',title:'params.title',kind:'SYSTEM_SIGNAL',source:'params.sourceSystem',summary:'params.summary',confidence:'0',verified:'false',recordedBy:'actor.id',observedAt:'params.eventTime',receivedAt:'now',reportedCompletion:'params.reportedCompletion',channelKey:'params.channelKey',sourceSystem:'params.sourceSystem',sourceRecordId:'params.sourceRecordId',sourceRevision:'params.sourceRevision',sourceEventKey:'params.sourceEventKey',sourceContentHash:'params.sourceContentHash',dataClassification:'params.classification'}},
      link('TaskObservation','task','newReport'),receipt('NativeRecordTaskObservation','Observation','newReport'),
    ]),
    NativeVerifyTaskObservation:manifest('NativeVerifyTaskObservation','data_reviewer',[
      'task._version == params.expectedVersion','observation._version == params.expectedObservationVersion','observation.recordedBy != actor.id',
      "params.result in ['DONE','NOT_DONE']",'params.targetTime == observation.observedAt',
    ],[
      {type:'createObject',objectType:'TaskCompletionVerification',as:'check',properties:{verificationKey:'params.commandKey',taskVersion:'params.expectedVersion',observationVersion:'params.expectedObservationVersion',result:'params.result',targetTime:'params.targetTime',recordedAt:'now',recordedBy:'actor.id',methodKey:'params.methodKey',mode:'params.mode',evidence:'params.evidence',classification:'params.classification'}},
      link('TaskCompletionCheck','task','check'),link('ObservationCompletionCheck','observation','check'),
      {type:'updateObject',target:'task',condition:"params.mode == 'GOLD' && (!has(task.actualCompletionAt) || task.actualCompletionAt == null || timestamp(params.targetTime) >= timestamp(task.actualCompletionAt))",set:{actualCompletion:'params.result',actualCompletionAt:'params.targetTime',actualCompletionRecordedAt:'now'}},
      receipt('NativeVerifyTaskObservation','TaskCompletionVerification','check'),
    ]),
  };
}
export function buildTaskVerificationInput(previous){
  const extension=readFileSync(new URL('./task-verification.odl',import.meta.url),'utf8');
  const manifests=taskVerificationManifests();
  if(Object.keys(manifests).some(name=>Object.hasOwn(previous.manifests,name)||previous.disabledActions.includes(name)))throw new Error('TASK_DOMAIN_ALREADY_PRESENT');
  return {odl:extendOdl(previous.odl,extension),manifests:{...previous.manifests,...manifests},disabledActions:[...previous.disabledActions]};
}

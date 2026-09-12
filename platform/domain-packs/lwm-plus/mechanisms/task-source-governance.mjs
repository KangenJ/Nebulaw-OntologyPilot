import { readFileSync } from 'node:fs';
import { extendOdl } from '../../../packages/odl/dist/index.js';
const receipt=(action,type,binding)=>({type:'createObject',objectType:'NativeCommandReceipt',properties:{commandKey:'params.commandKey',commandHash:'params.commandHash',actorId:'actor.id',actionName:action,resultType:type,resultId:binding+'._id',traceId:'params.traceId',createdAt:'now'}});
const manifest=(action,conditions,effects)=>({action,version:1,reversible:false,preconditions:["actor.hasRole('model_owner')",...conditions].map(expr=>({expr,error:'Native source repair precondition failed'})),effects,sideEffects:[]});
export function taskSourceGovernanceManifests(){return {
 NativeInvalidateTaskVerification:manifest('NativeInvalidateTaskVerification',['verification._version == params.expectedVersion'],[
  {type:'updateObject',target:'verification',set:{validity:'REVOKED',revokedAt:'now',revokedBy:'actor.id',revocationReason:'params.reason'}},
  receipt('NativeInvalidateTaskVerification','TaskCompletionVerification','verification'),
 ]),
 NativeRebuildTaskCompletion:manifest('NativeRebuildTaskCompletion',['task._version == params.expectedVersion',"(params.result == 'UNKNOWN' && params.targetTime == null) || (params.result in ['DONE','NOT_DONE'] && params.targetTime != null)"],[
  {type:'updateObject',target:'task',set:{actualCompletion:'params.result',actualCompletionAt:'params.targetTime',actualCompletionRecordedAt:'now'}},
  {type:'createObject',objectType:'TaskCompletionRepair',as:'repair',properties:{repairKey:'params.commandKey',previousTaskVersion:'params.expectedVersion',result:'params.result',targetTime:'params.targetTime',basisStatus:'params.basisStatus',basis:'params.basis',recordedAt:'now',recordedBy:'actor.id',classification:'params.classification',reason:'params.reason'}},
  {type:'createLink',linkType:'TaskCompletionRepairs',from:'task',to:'repair'},
  receipt('NativeRebuildTaskCompletion','TaskCompletionRepair','repair'),
 ]),
};}
export function buildTaskSourceGovernanceInput(previous){
 const manifests=taskSourceGovernanceManifests();
 if(Object.keys(manifests).some(name=>Object.hasOwn(previous.manifests,name)||previous.disabledActions.includes(name)))throw new Error('TASK_SOURCE_GOVERNANCE_ALREADY_PRESENT');
 return {odl:extendOdl(previous.odl,readFileSync(new URL('./task-source-governance.odl',import.meta.url),'utf8')),manifests:{...previous.manifests,...manifests},disabledActions:[...previous.disabledActions]};
}

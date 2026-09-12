import { readFileSync } from 'node:fs';
import { extendOdl } from '../../../packages/odl/dist/index.js';
import { taskVerificationManifests } from './task-verification.mjs';
import { parseActionManifest } from '../../../packages/actions/dist/index.js';
import { digest } from '../../../packages/plus-contracts/dist/index.js';
export function taskPriorityRegistrationManifest(){
  const manifest=taskVerificationManifests().NativeRegisterInvestigationTask;
  manifest.version=2;
  Object.assign(manifest.effects.find(e=>e.type==='createObject'&&e.objectType==='InvestigationTask').properties,
    {priorityEffectiveAt:'now',priorityRecordedAt:'now'});
  return manifest;
}
export function taskPriorityManifest(){return {action:'NativeSetTaskPriority',version:1,reversible:false,preconditions:[
  "actor.hasRole('investigator')",'task._version == params.expectedVersion','task.priority == params.previousPriority',
  'task.priority != params.priority',"task.status in ['OPEN','IN_PROGRESS']",
  'timestamp(params.effectiveAt) >= timestamp(params.previousEffectiveAt)',
  'timestamp(params.effectiveAt) <= timestamp(now)','timestamp(now) > timestamp(params.previousRecordedAt)',
].map(expr=>({expr,error:'Task priority/time precondition failed'})),effects:[
  {type:'createObject',objectType:'TaskPriorityChange',as:'change',properties:{changeKey:'params.commandKey',taskVersion:'params.expectedVersion',previousPriority:'params.previousPriority',priority:'params.priority',
    previousEffectiveAt:'params.previousEffectiveAt',previousRecordedAt:'params.previousRecordedAt',effectiveAt:'params.effectiveAt',recordedAt:'now',recordedBy:'actor.id',reason:'params.reason',workspaceKey:'task.workspaceKey',classification:'params.classification'}},
  {type:'updateObject',target:'task',set:{priority:'params.priority',priorityEffectiveAt:'params.effectiveAt',priorityRecordedAt:'now'}},
  {type:'createLink',linkType:'TaskPriorityChanges',from:'task',to:'change'},
  {type:'createObject',objectType:'NativeCommandReceipt',properties:{commandKey:'params.commandKey',commandHash:'params.commandHash',actorId:'actor.id',actionName:'NativeSetTaskPriority',resultType:'TaskPriorityChange',resultId:'change._id',traceId:'params.traceId',createdAt:'now'}},
],sideEffects:[]};}
export function buildTaskPriorityInput(previous,{initializePriority=false}={}){
  const action='NativeSetTaskPriority';if(Object.hasOwn(previous.manifests,action)||previous.disabledActions.includes(action))throw new Error('TASK_PRIORITY_ALREADY_PRESENT');
  if(initializePriority&&(!previous.manifests.NativeRegisterInvestigationTask||previous.disabledActions.includes('NativeRegisterInvestigationTask')))throw new Error('TASK_REGISTRATION_REQUIRED');
  if(initializePriority){
    const before=parseActionManifest(JSON.stringify(previous.manifests.NativeRegisterInvestigationTask)),expected=parseActionManifest(JSON.stringify(taskVerificationManifests().NativeRegisterInvestigationTask));
    if(!before.valid||!expected.valid||digest(before.manifest)!==digest(expected.manifest))throw new Error('TASK_REGISTRATION_CONTRACT_STALE');
  }
  return {odl:extendOdl(previous.odl,readFileSync(new URL('./task-priority.odl',import.meta.url),'utf8')),manifests:{...previous.manifests,[action]:taskPriorityManifest(),
    ...(initializePriority?{NativeRegisterInvestigationTask:taskPriorityRegistrationManifest()}: {})},disabledActions:[...previous.disabledActions]};
}

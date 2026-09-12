import {readFileSync} from 'node:fs';
import {extendOdl} from '../../../packages/odl/dist/index.js';
export const matterIntakeAction='NativeImportTaskMatter';
export const matterIntakeFields=['matterNumber','title','jurisdiction','currentState','riskBand','openedAt','sourceSystem','sourceRecordId','sourceRevision'];
export const matterIntakeWrites=['workspaceKey','matterNumber','title','jurisdiction','status','currentState','riskBand','owner','openedAt','importSourceSystem','importSourceRecordId','importSourceRevision','importSourceKey','importContentHash','importedAt','dataClassification'];
export function matterIntakeManifest(){return {action:matterIntakeAction,version:1,reversible:false,
  preconditions:["actor.hasRole('investigator')","params.classification in ['SYNTHETIC','AUTHORIZED_REAL','IMPORTED_UNVERIFIED']",'timestamp(params.openedAt) <= timestamp(now)'].map(expr=>({expr,error:'Native matter import precondition failed'})),
  effects:[
    {type:'createObject',objectType:'Matter',as:'matter',properties:{workspaceKey:'params.workspaceKey',matterNumber:'params.matterNumber',title:'params.title',jurisdiction:'params.jurisdiction',status:'NEW',currentState:'params.currentState',riskBand:'params.riskBand',owner:'actor.id',openedAt:'params.openedAt',
      importSourceSystem:'params.sourceSystem',importSourceRecordId:'params.sourceRecordId',importSourceRevision:'params.sourceRevision',importSourceKey:'params.sourceKey',importContentHash:'params.contentHash',importedAt:'now',dataClassification:'params.classification'}},
    {type:'createObject',objectType:'NativeCommandReceipt',properties:{commandKey:'params.commandKey',commandHash:'params.commandHash',actorId:'actor.id',actionName:matterIntakeAction,resultType:'Matter',resultId:'matter._id',traceId:'params.traceId',createdAt:'now'}},
  ],sideEffects:[]};}
export function buildMatterIntakeInput(previous){
  if(Object.hasOwn(previous.manifests,matterIntakeAction)||previous.disabledActions.includes(matterIntakeAction))throw Error('MATTER_INTAKE_ALREADY_PRESENT');
  return {odl:extendOdl(previous.odl,readFileSync(new URL('./matter-intake.odl',import.meta.url),'utf8')),manifests:{...previous.manifests,[matterIntakeAction]:matterIntakeManifest()},disabledActions:[...previous.disabledActions]};
}

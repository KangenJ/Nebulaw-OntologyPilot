import {readFileSync} from 'node:fs';
import {extendOdl} from '../../../packages/odl/dist/index.js';
export const ruleIntakeAction='NativeImportTaskRule';
export const ruleIntakeFields=['ruleKey','title','versionTag','effectiveFrom','sourceCitation','sourceSystem','sourceRecordId','sourceRevision'];
export const ruleIntakeWrites=['workspaceKey','ruleKey','title','versionTag','lifecycle','effectiveFrom','sourceCitation','deterministic','importSourceSystem','importSourceRecordId','importSourceRevision','importSourceKey','importContentHash','importedAt','importedBy','dataClassification'];
export function ruleIntakeManifest(){return {action:ruleIntakeAction,version:1,reversible:false,
  preconditions:["actor.hasRole('data_reviewer')","params.classification in ['SYNTHETIC','AUTHORIZED_REAL','IMPORTED_UNVERIFIED']",'timestamp(params.effectiveFrom) <= timestamp(now)'].map(expr=>({expr,error:'Native rule source import precondition failed'})),
  effects:[
    {type:'createObject',objectType:'RuleVersion',as:'rule',properties:{workspaceKey:'params.workspaceKey',ruleKey:'params.ruleKey',title:'params.title',versionTag:'params.versionTag',lifecycle:'ACTIVE',effectiveFrom:'params.effectiveFrom',sourceCitation:'params.sourceCitation',deterministic:true,
      importSourceSystem:'params.sourceSystem',importSourceRecordId:'params.sourceRecordId',importSourceRevision:'params.sourceRevision',importSourceKey:'params.sourceKey',importContentHash:'params.contentHash',importedAt:'now',importedBy:'actor.id',dataClassification:'params.classification'}},
    {type:'createObject',objectType:'NativeCommandReceipt',properties:{commandKey:'params.commandKey',commandHash:'params.commandHash',actorId:'actor.id',actionName:ruleIntakeAction,resultType:'RuleVersion',resultId:'rule._id',traceId:'params.traceId',createdAt:'now'}},
  ],sideEffects:[]};}
export function buildRuleIntakeInput(previous){
  if(Object.hasOwn(previous.manifests,ruleIntakeAction)||previous.disabledActions.includes(ruleIntakeAction))throw Error('RULE_INTAKE_ALREADY_PRESENT');
  return {odl:extendOdl(previous.odl,readFileSync(new URL('./rule-intake.odl',import.meta.url),'utf8')),manifests:{...previous.manifests,[ruleIntakeAction]:ruleIntakeManifest()},disabledActions:[...previous.disabledActions]};
}

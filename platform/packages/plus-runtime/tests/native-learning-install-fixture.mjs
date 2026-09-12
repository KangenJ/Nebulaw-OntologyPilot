import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {digest} from '../../plus-contracts/dist/index.js';
import {planNativeDomain,applyNativeDomainPlan,readBootstrapFile} from '../../../../ops/plus-v2/native-domain-bootstrap.mjs';
import {startNativeRuntime,readNativeRuntimeProfile} from '../../../../ops/plus-v2/runtime-host.mjs';
// Actual production bootstrap/actions/publication; no direct source seeding.
export async function nativeLearningInstallFixture(t,{historicalObservation=false}={}){
  const parent=mkdtempSync(join(tmpdir(),'plus-learning-install-')),request={schema:'plus-domain-bootstrap-request-v1',parentDir:parent,directoryName:'native',tenantId:'learning-install',workspaceKey:'demo',ports:{control:0,workbench:0,cel:0},credentialHours:8};
  const domain=await planNativeDomain(request),installed=await applyNativeDomainPlan(domain,domain.planHash),profile=readNativeRuntimeProfile(installed.profilePath);let runtime;
  t.after(async()=>{await runtime?.close();rmSync(parent,{recursive:true,force:true});});
  const start=async p=>{runtime=await startNativeRuntime(p,{celBinary:process.env.LWM_CEL_BINARY});return runtime;};await start(profile);
  const token=role=>readBootstrapFile(installed.personalAccessFiles.find(v=>v.roles.includes(role)).path).token;
  const call=async(role,path,body,key='learning-install-request')=>{const r=await fetch(runtime.state().workbenchUrl+'/api'+path,{method:body?'POST':'GET',
    headers:{authorization:'Bearer '+token(role),...(body?{'content-type':'application/json','idempotency-key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};};
  const ok=async(...args)=>{const value=await call(...args);assert.equal(value.status,200,JSON.stringify(value.body));return value.body.data;};
  // Checked-in production domain, actual authenticated native actions and
  // independent definition publication. No test-fixture object/label seeding.
  const candidate=await ok('data_reviewer','/definitions/task.completion/candidate');
  const draft=await ok('data_reviewer','/definitions/task.completion/revisions',{definition:candidate.definition,expectedCompiledHash:candidate.compiledHash});
  const valid=await ok('data_reviewer','/definitions/task.completion/revisions/'+draft._id+'/validate',{expectedVersion:draft._version});
  await ok('model_owner','/definitions/task.completion/revisions/'+valid._id+'/review',{expectedVersion:valid._version,decision:'APPROVE'});
  const parameters=await ok('viewer','/definitions/task.completion/parameters');
  const imported=await ok('investigator','/actions/NativeImportTaskMatter',{matterNumber:'LEARNING-1',title:'SYNTHETIC source for installed learning access',jurisdiction:'TEST',currentState:'UNASSESSED',riskBand:'LOW',openedAt:new Date(Date.now()-1000).toISOString(),sourceSystem:'demo-matter',sourceRecordId:'learning-root',sourceRevision:'1'},'learning-root-import');
  const matter=(await ok('viewer','/objects/Matter/'+imported.receipt.resultId)).object;
  const registered=await ok('investigator','/actions/NativeRegisterInvestigationTask',{matter:matter._id,expectedVersion:matter._version,taskNumber:'LEARNING-TASK',title:'SYNTHETIC current task',priority:'LOW',assignee:'demo-investigator',instructions:'No labels implied',dueAt:new Date(Date.now()+3600000).toISOString()},'learning-task-register');
  const task=(await ok('viewer','/objects/InvestigationTask/'+registered.receipt.resultId)).object;
  const eventTime=new Date(Date.now()-(historicalObservation?3600000:0)).toISOString();await ok('investigator','/actions/NativeRecordTaskObservation',{task:task._id,expectedVersion:task._version,title:'SYNTHETIC unknown report',summary:'Not a verified label',reportedCompletion:'UNKNOWN',eventTime,channelKey:'report',sourceSystem:'demo-report',sourceRecordId:'learning-report',sourceRevision:'1'},'learning-report-record');
  await runtime.close();
  const input={schema:'plus-native-learning-access-request-v1',profilePath:installed.profilePath,outputParent:parent,directoryName:'learning-access',definitionKey:'task.completion',expectedDefinitionHash:parameters.definition.definitionHash,
    workspaceKey:'demo',targetVariable:'completion',principals:{trainer:'demo-trainer',reviewer:'demo-data_reviewer',owner:'demo-model_owner'},groups:[{matterId:matter._id,expectedVersion:matter._version}],
    feedback:{key:'demo-feedback',collectionPolicyHash:digest('Explicit synthetic learning-access test protocol; no model qualification'),minimumMaturityMs:0},partition:{seed:'fixed-before-any-label',boundaries:[6000,7500,9000,10000]}};
  return {parent,profile,input,start,call,ok,task,matter,eventTime,runtime:()=>runtime};
}

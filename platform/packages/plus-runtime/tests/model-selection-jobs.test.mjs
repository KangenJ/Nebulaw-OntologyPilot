import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '@openfoundry/plus-contracts';
import {NativeModelSelectionJobs,NativeModelDeployment} from '../dist/index.js';
import {modelAdmissionFixture,admissionOwner as owner,ctx} from './model-admission-fixture.mjs';

// Real native selection/job/receipt/outbox transactions and reopen. Upstream
// evaluator and recipe providers are explicit model-admission governance doubles,
// not a complete FIT, HTTP, user login, browser or business-efficacy claim.
async function fixture(t){
  const f=await modelAdmissionFixture(t),approved=await f.decisions.decide(f.input,owner),{version,id,...target}=f.policy;
  const worker={id:'selection-worker',tenantId:ctx.tenantId,roles:['plus_governance_worker']};
  const control={epoch:1,allow:true,ownerRoles:[...owner.roles],failStage:false};let now=f.config.clock();
  const selectedPolicy={version:'plus-selection-job-policy-v1',workerId:worker.id,leaseMs:1000,maxAttempts:2};
  const authority=async()=>digest({control: {epoch:control.epoch,allow:control.allow,ownerRoles:control.ownerRoles},target,selectedPolicy});
  const deploymentConfig={storage:f.storage,tenantId:ctx.tenantId,decisions:f.decisions,authorize:async p=>control.allow&&p.id===owner.id,
    targetFor:async()=>structuredClone(target),authorizationRevision:authority,clock:()=>now};
  let runtime=new NativeModelDeployment(deploymentConfig);
  const config={storage:f.storage,tenantId:ctx.tenantId,runtimeFor:()=>({prepareSelection:(...a)=>runtime.prepareSelection(...a),
    executePreparedSelection:(command,p,prepared,guard)=>runtime.executePreparedSelection(command,p,prepared,{...guard,stage:async(...args)=>{
      await guard.stage(...args);if(control.failStage)throw Error('TEST_AFTER_STAGED_COMPLETION');
    }})}),resolvePrincipal:async id=>{if(id!==owner.id)throw Error('TEST_UNKNOWN_SUBMITTER');return {...owner,roles:[...control.ownerRoles]};},
    authorize:async(p,permission,key)=>control.allow&&key==='unit.selection'&&(p.id===owner.id?['selection-job:enqueue','selection-job:read','selection-job:cancel'].includes(permission)
      :p.id===worker.id&&['selection-job:read','selection-job:claim','selection-job:run','selection-job:fail','selection-job:reconcile'].includes(permission)),
    policyFor:async()=>structuredClone(selectedPolicy),authorizationRevision:authority,clock:()=>now};
  const command={mode:'ACTIVATE',input:{key:'unit.selection',expectedVersion:0,decisionId:approved.id,requestKey:'first-selection',reason:'SYNTHETIC governance unit'}};
  const jobs=new NativeModelSelectionJobs(config),rows=type=>f.storage.queryObjects(ctx,type,{and:[]});
  const reopen=()=>{const storage=f.openStorage();runtime=new NativeModelDeployment({...deploymentConfig,storage});return new NativeModelSelectionJobs({...config,storage});};
  return {...f,approved,worker,control,config,command,jobs,rows,reopen,deploymentConfig,selectedPolicy,advance:ms=>now+=ms};
}

test('enqueue is metadata-only; actual selection, job receipt and both audits commit together and survive reopen',async t=>{
  const f=await fixture(t),initial=structuredClone(f.root),read=f.decisions.requireApproved.bind(f.decisions);let qualifications=0;
  f.decisions.requireApproved=async(...args)=>{qualifications++;return read(...args);};
  const job=await f.jobs.enqueue(f.command,owner);assert.equal(job.status,'PENDING');assert.equal(qualifications,0);assert.equal((await f.rows('PlusDeployment')).totalCount,0);
  const epoch=await f.storage.getReadRevision(ctx);assert.equal((await f.jobs.enqueue(f.command,owner)).id,job.id);assert.equal(await f.storage.getReadRevision(ctx),epoch);
  const lease=await f.jobs.claim(job.id,f.worker);assert.equal(qualifications,0);
  const result=await f.jobs.run(job.id,lease.version,lease.leaseToken,f.worker);assert.equal(result.status,'SUCCEEDED');assert.equal(qualifications,2,'independent initial and precommit model/data qualification remains');
  const reopened=f.reopen(),before=await f.storage.getReadRevision(ctx),history=await reopened.listOwn('unit.selection',owner);
  assert.equal(history.items[0].id,job.id);assert.equal(history.items[0].recordedSelection.revisionId,result.recordedSelection.revisionId);
  assert.equal((await reopened.run(job.id,lease.version,lease.leaseToken,f.worker)).status,'SUCCEEDED');assert.equal(await f.storage.getReadRevision(ctx),before);
  const stored=await f.storage.getObject(ctx,'PlusExecution',job.id);assert.equal(stored.leaseToken,null);assert.equal(stored.leaseUntil,null);
  const journal=(await f.rows('PlusOutbox')).items.map(r=>r.envelope.audit.operation.actionType);
  assert.equal(journal.filter(v=>v==='PlusActivateModelSelection').length,1);assert.equal(journal.filter(v=>v==='PlusCompleteModelSelection').length,1);
  assert.deepEqual(await f.storage.getObject(ctx,'Machine',initial._id),initial);
  for(const field of ['leaseToken','inputReadSet','reason','requestKey'])assert.equal(JSON.stringify(history).includes(field),false);
  await assert.rejects(()=>reopened.cancel(job.id,result.version,owner),/CONFLICT/);
});

test('failure after staging completion rolls back native selection, job result and audits; exact retry succeeds',async t=>{
  const f=await fixture(t),job=await f.jobs.enqueue(f.command,owner),lease=await f.jobs.claim(job.id,f.worker),epoch=await f.storage.getReadRevision(ctx);
  f.control.failStage=true;await assert.rejects(()=>f.jobs.run(job.id,lease.version,lease.leaseToken,f.worker),/TEST_AFTER_STAGED_COMPLETION/);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal((await f.rows('PlusDeployment')).totalCount,0);assert.equal((await f.rows('PlusDeploymentRevision')).totalCount,0);
  assert.equal((await f.jobs.read(job.id,owner)).status,'LEASED');assert.equal((await f.storage.getLinks(ctx,job.id,'PlusExecutionSelectionResult','outbound')).totalCount,0);
  f.control.failStage=false;assert.equal((await f.reopen().run(job.id,lease.version,lease.leaseToken,f.worker)).status,'SUCCEEDED');
});

test('cancel during native qualification prevents the effect, and stale lease holders cannot complete a reclaimed job',async t=>{
  const f=await fixture(t),job=await f.jobs.enqueue(f.command,owner),lease=await f.jobs.claim(job.id,f.worker);
  let enter,release,armed=true;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
  f.state.beforeRead=async()=>{if(armed){armed=false;enter();await gate;}};
  const running=f.jobs.run(job.id,lease.version,lease.leaseToken,f.worker);
  const rejected=assert.rejects(running,/CONFLICT|STALE/);await entered;
  assert.equal((await f.jobs.cancel(job.id,lease.version,owner)).status,'CANCELLED');release();await rejected;assert.equal(armed,false);
  assert.equal((await f.rows('PlusDeployment')).totalCount,0);
  const next=await f.jobs.enqueue({...f.command,input:{...f.command.input,requestKey:'recover-expiry'}},owner),old=await f.jobs.claim(next.id,f.worker);
  f.advance(1001);const current=await f.reopen().claim(next.id,f.worker);
  await assert.rejects(()=>f.jobs.run(next.id,old.version,old.leaseToken,f.worker),/LEASE_CONFLICT/);
  assert.equal((await f.jobs.run(next.id,current.version,current.leaseToken,f.worker)).status,'SUCCEEDED');
});

test('source qualification, changed owner roles and precommit authority remain mandatory after enqueue',async t=>{
  const f=await fixture(t),job=await f.jobs.enqueue(f.command,owner),lease=await f.jobs.claim(job.id,f.worker),read=f.decisions.requireApproved.bind(f.decisions);
  f.decisions.requireApproved=async()=>{throw Object.assign(Error('SOURCE_WITHDRAWN'),{code:'SOURCE_WITHDRAWN'});};
  await assert.rejects(()=>f.jobs.run(job.id,lease.version,lease.leaseToken,f.worker),/SOURCE_WITHDRAWN/);assert.equal((await f.rows('PlusDeployment')).totalCount,0);
  f.decisions.requireApproved=read;f.control.ownerRoles=['viewer'];await assert.rejects(()=>f.jobs.run(job.id,lease.version,lease.leaseToken,f.worker),/SUBMITTER_STALE/);
  f.control.ownerRoles=[...owner.roles];let injected=false;
  f.state.beforeRead=async()=>{if(!injected){injected=true;f.control.epoch++;}};
  await assert.rejects(()=>f.jobs.run(job.id,lease.version,lease.leaseToken,f.worker),/AUTHORITY_STALE/);assert.equal(injected,true);assert.equal((await f.rows('PlusDeployment')).totalCount,0);
});

test('prepared decision version and target are pinned, but read-only job history does not claim current model eligibility',async t=>{
  const f=await fixture(t),job=await f.jobs.enqueue(f.command,owner),lease=await f.jobs.claim(job.id,f.worker);
  await f.decisions.revoke(f.approved.id,f.approved.version,'withdraw the admission',owner);
  assert.equal((await f.jobs.read(job.id,owner)).qualification,'NOT_CHECKED');
  assert.equal((await f.jobs.enqueue(f.command,owner)).id,job.id,'exact unknown-request lookup must not create a replacement');
  await assert.rejects(()=>f.jobs.run(job.id,lease.version,lease.leaseToken,f.worker),/STALE|APPROVED|REVOKED/);
  const different={...f.command,input:{...f.command.input,reason:'changed intent'}};await assert.rejects(()=>f.jobs.enqueue(different,owner),/CONFLICT/);
  assert.equal((await f.rows('PlusDeployment')).totalCount,0);
});

test('worker failure and exhausted leases have bounded recovery; caller cannot provide success or act as worker',async t=>{
  const f=await fixture(t),job=await f.jobs.enqueue(f.command,owner);
  await assert.rejects(()=>f.jobs.claim(job.id,owner),/FORBIDDEN/);
  await assert.rejects(()=>f.jobs.enqueue({...f.command,result:{status:'SUCCEEDED'}},owner),/INVALID_INPUT/);
  const first=await f.jobs.claim(job.id,f.worker);assert.equal((await f.jobs.failAttempt(job.id,first.version,first.leaseToken,f.worker)).status,'PENDING');
  const second=await f.jobs.claim(job.id,f.worker);f.advance(1001);
  await assert.rejects(()=>f.jobs.claim(job.id,f.worker),/ATTEMPTS_EXHAUSTED/);
  assert.equal((await f.jobs.reconcileExhausted(job.id,second.version,f.worker)).status,'FAILED');assert.equal((await f.rows('PlusDeployment')).totalCount,0);
});

test('a durable job can acknowledge an already committed exact native selection without another switch',async t=>{
  const f=await fixture(t),direct=new NativeModelDeployment(f.deploymentConfig),selected=await direct.activate(f.command.input,owner);
  const job=await f.jobs.enqueue(f.command,owner),lease=await f.jobs.claim(job.id,f.worker);
  const result=await f.jobs.run(job.id,lease.version,lease.leaseToken,f.worker);
  assert.equal(result.recordedSelection.revisionId,selected.revisionId);assert.equal((await f.rows('PlusDeploymentRevision')).totalCount,1);
  assert.equal((await f.reopen().read(job.id,owner)).status,'SUCCEEDED');
});

test('rollback jobs reuse native historical selection and never restore business facts',async t=>{
  const f=await fixture(t),direct=new NativeModelDeployment(f.deploymentConfig),first=await direct.activate(f.command.input,owner),next=await f.candidate('next');
  const approved=await f.decisions.decide({...f.input,evaluationId:next.evaluation._id,evaluationVersion:next.evaluation._version},owner);
  const second=await direct.activate({...f.command.input,decisionId:approved.id,expectedVersion:first.version,requestKey:'second'},owner);
  const input={key:'unit.selection',expectedVersion:second.version,revisionId:first.revisionId,requestKey:'restore-first',reason:'qualified model only'};
  const job=await f.jobs.enqueue({mode:'ROLLBACK',input},owner),lease=await f.jobs.claim(job.id,f.worker);
  const done=await f.jobs.run(job.id,lease.version,lease.leaseToken,f.worker),current=await direct.read('unit.selection',owner);
  assert.equal(done.status,'SUCCEEDED');assert.equal(current.record.generation,3);assert.equal(current.selection.release.id,f.release._id);
  assert.equal(done.recordedSelection.revisionId,current.revision._id);assert.equal((await f.rows('PlusDeploymentRevision')).totalCount,3);
  assert.deepEqual(await f.storage.getObject(ctx,'Machine',f.root._id),f.root);
});

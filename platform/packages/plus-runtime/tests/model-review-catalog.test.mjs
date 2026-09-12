import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {writeFileSync,rmSync} from 'node:fs';
import {digest} from '@openfoundry/plus-contracts';
import {NativeRecipeRegistry,createPlusLearningHandler} from '../dist/index.js';
import {modelEvaluationFixture,ctx,trainer,owner} from './model-evaluation-fixture.mjs';
import {createPrivateIdentityProvider} from '../../../../ops/plus-v2/private-identity.mjs';
import {createPrivateAuthorizationRevision} from '../../../../ops/plus-v2/private-authority.mjs';
import {createPrivateEvaluationServices} from '../../../../ops/plus-v2/evaluation-services.mjs';
import {createPrivateModelDecisionReviewCatalog} from '../../../../ops/plus-v2/model-decision-review-catalog.mjs';
import {createPrivateModelGovernanceServices} from '../../../../ops/plus-v2/model-governance.mjs';
import {createPrivateModelDecisionJobServices} from '../../../../ops/plus-v2/model-decision-job-services.mjs';
import {createAppServer} from '../../../apps/lwm-demo/server.mjs';
import {createModelDecisionWorker} from '../../../../ops/plus-v2/model-decision-worker.mjs';
import {createNativeModelReview} from '../../../apps/lwm-demo/public-plus/native-model-review-ui.js';
import {createNativeDecisionJobs} from '../../../apps/lwm-demo/public-plus/native-decision-jobs-ui.js';

// Actual native synthetic Machine FIT, numerical scoring, SQLite records/links,
// private file identity and shipped gateway. Upstream training/source authority
// is the explicit fixture adapter, not canonical Task or browser acceptance.
async function fixture(t,{qualified=false}={}){
  const f=await modelEvaluationFixture(t,{stateEvaluation:true}),score=await f.evaluations.evaluate(f.request,trainer);
  const protocol=await f.storage.getObject(ctx,'PlusEvaluationProtocol',f.request.protocolId),recipe=await f.storage.getObject(ctx,'PlusModelRecipe',f.recipeApproval.id);
  const key='model.review',worker={id:'review-worker',tenantId:ctx.tenantId,roles:['plus_governance_worker']};
  const policy={recipeRead:true,modelGovernance:{version:'plus-private-model-governance-v1',enabled:true,targets:[{key,policy:{version:'plus-model-admission-v1',id:'review-purpose',
    definitionHash:recipe.definitionHash,bindingHash:recipe.payload.config.bindingHash,scopeKey:recipe.payload.compiled.definition.scope.key,classification:'SYNTHETIC',task:'STATE_ESTIMATION',clockHash:digest(protocol.payload.configuration.clock)}}],
    grants:[{principalId:owner.id,requiredRoles:['model_owner'],keys:[key],permissions:['model:decide','model:decision-read']}]},
    evaluation:{version:'plus-private-evaluation-v1',enabled:true,protocols:[{key:protocol.protocolKey,purpose:f.evaluationPurpose}],
      grants:[{principalId:owner.id,requiredRoles:['model_owner'],protocolKeys:[protocol.protocolKey],permissions:['evaluation:read','evaluation:result-read']}]},
    decisionJobs:{version:'plus-private-decision-jobs-v1',enabled:true,targets:[{key,policy:{version:'plus-decision-job-policy-v1',workerId:worker.id,leaseMs:300000,maxAttempts:2}}],
      grants:[{principalId:owner.id,requiredRoles:['model_owner'],keys:[key],permissions:['decision-job:enqueue','decision-job:read']}]}};
  const authPath=f.path+'.review-auth.json',token='synthetic-review-owner',accounts=[{...owner,tokenHash:createHash('sha256').update(token).digest('hex'),expiresAt:new Date(Date.now()+600000).toISOString()}];
  const save=()=>writeFileSync(authPath,JSON.stringify(accounts),{mode:0o600});save();t.after(()=>rmSync(authPath,{force:true}));
  if(qualified){accounts.push({...worker,tokenHash:createHash('sha256').update('worker-not-used-by-browser').digest('hex'),expiresAt:new Date(Date.now()+600000).toISOString()});save();
    policy.evaluation.grants[0].permissions.push('evaluation:use');
    policy.decisionJobs.grants.push({principalId:worker.id,requiredRoles:['plus_governance_worker'],keys:[key],permissions:['decision-job:read','decision-job:claim','decision-job:run','decision-job:fail','decision-job:reconcile']});}
  const identities=createPrivateIdentityProvider({authPath,tenantId:ctx.tenantId});
  let storage=f.storage,hook;const options={tenantId:ctx.tenantId,identities,loadPolicy:()=>structuredClone(policy),clock:f.evaluationConfig.clock};
  const forbidden=async()=>{throw Error('UNEXPECTED_DEEP_QUALIFICATION');};
  function servicesFor(reauthenticate){
    const current={...options,storage,reauthenticate},authority=createPrivateAuthorizationRevision(current);
    const recipeConfig={...(qualified?f.recipes.config:{definitions:{requirePublished:forbidden},policyFor:forbidden,validateRecipe:forbidden}),storage,tenantId:ctx.tenantId,authorizationRevision:authority,
      authorize:async(p,permission,k)=>{await authority(p);return policy.recipeRead&&p.id===owner.id&&permission==='recipe:read'&&k===recipe.recipeKey;},clock:options.clock};
    const recipes=new NativeRecipeRegistry(recipeConfig);
    const evaluation=createPrivateEvaluationServices({...current,learning:{recipes,datasets:f.registry,temporalInputs:f.runtime},compute:f.compute});
    const governance=createPrivateModelGovernanceServices({...current,evaluations:evaluation.evaluations,recipes});
    const jobs=createPrivateModelDecisionJobServices({...current,decisions:governance.decisions});
    const catalogOptions={...current,evaluations:evaluation.evaluations,protocols:evaluation.protocols,recipes,resultKeys:evaluation.resultKeys,authorizeEvaluation:evaluation.protocolConfiguration.authorize};
    hook?.({recipeConfig,evaluation,catalogOptions});
    return {decisionJobs:jobs.decisionJobs,modelReview:createPrivateModelDecisionReviewCatalog(catalogOptions),evaluation,recipes,assertConfigured:()=>{jobs.assertConfigured();governance.assertConfigured();evaluation.assertConfigured();}};
  }
  return {...f,score,protocol,recipe,key,policy,accounts,save,token,options,servicesFor,setHook:v=>hook=v,setStorage:v=>storage=v};
}

test('owner discovers real score evidence without trainer history or deployment-read and without deep qualification',async t=>{
  const f=await fixture(t),epoch=await f.storage.getReadRevision(ctx),services=f.servicesFor(),result=await services.modelReview.read(owner);
  assert.equal(result.schema,'plus-model-decision-review-v1');assert.equal(result.qualification,'NOT_CHECKED');assert.deepEqual(result.keys,[f.key]);assert.equal(result.items.length,1);
  const item=result.items[0];assert.equal(item.score.id,f.score.id);assert.deepEqual(item.score.result,(await f.storage.getObject(ctx,'PlusModelEvaluation',f.score.id)).result);
  assert.equal(item.recipe.definitionHash,f.recipe.definitionHash);assert.equal(item.recipe.bindingHash,f.recipe.payload.config.bindingHash);
  assert.equal(item.protocol.configuration.maximumNllRegression,0);assert.equal(item.score.evidence.trainingDatasets.length,1);
  assert.equal(item.command.evaluationVersion,f.score.version);assert.equal(item.qualification,'NOT_CHECKED');
  assert.equal(Object.hasOwn(item.recipe,'payload'),false);assert.equal(Object.hasOwn(item.score,'inputReadSet'),false);
  assert.equal(Object.hasOwn(item.score.evidence,'transition'),false);assert.equal(result.predictionReady,false);assert.equal(result.executionAuthorized,false);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal((await f.rows('PlusModelDecision')).totalCount,0);
  item.protocol.configuration.maximumNllRegression=999;
  assert.equal((await services.modelReview.read(owner)).items[0].protocol.configuration.maximumNllRegression,0);
  await assert.rejects(()=>services.evaluation.evaluations.read(f.score.id,owner),/EVALUATION_FORBIDDEN/);
  f.policy.evaluation.grants[0].permissions.push('evaluation:use');
  await assert.rejects(()=>services.evaluation.evaluations.read(f.score.id,owner),/UNEXPECTED_DEEP_QUALIFICATION/);
});

test('shipped owner form reads real gateway evidence, explicitly approves through fixed worker and recovers after reopening SQLite',async t=>{
  const f=await fixture(t,{qualified:true}),handler=createPlusLearningHandler({tenantId:ctx.tenantId,authenticate:f.options.identities.authenticate,
    createServices:({reauthenticate})=>f.servicesFor(reauthenticate),recordFailure:async()=>{}});
  const server=createServer(async(req,res)=>{if(!await handler(req,res)){res.writeHead(404);res.end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const gateway=createAppServer({platformUrl:'http://127.0.0.1:'+server.address().port,platformApiPrefix:'/api/plus/v2'});await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
  t.after(async()=>{for(const s of [gateway,server]){s.closeAllConnections();await new Promise(r=>s.close(r));}});
  const calls=[],saved=new Map(),storage={getItem:k=>saved.get(k)??null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)};
  const api=async(path,epoch,body)=>{calls.push({path,body});const response=await fetch('http://127.0.0.1:'+gateway.address().port+'/api'+path,{method:body?'POST':'GET',
    headers:{authorization:'Bearer '+f.token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(60000)});
    const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value.data;};
  function view(){const nodes=new Map(),$=s=>{if(!nodes.has(s))nodes.set(s,{});return nodes.get(s);};let busy=false,last=Promise.resolve();
    const run=fn=>{busy=true;last=fn(1).finally(()=>busy=false);return last;},common={document:{querySelector:$,querySelectorAll:()=>[]},api,run,isBusy:()=>busy,getPrincipal:()=>owner};
    const jobs=createNativeDecisionJobs({...common,getStorage:()=>storage}),review=createNativeModelReview({...common,onSubmit:command=>jobs.submit(command),onHistory:key=>jobs.load(key),newKey:()=> 'explicit-owner-original'});
    review.render();jobs.render();return {$,jobs,review,settle:()=>last};}
  const first=view();await first.review.load();const options=calls.length;assert.equal(options,1);assert.equal((await f.rows('PlusModelDecision')).totalCount,0);
  const option=(await f.servicesFor().modelReview.read(owner)).items[0];first.$('#model-review-choice').value=option.optionKey;first.$('#model-review-choice').onchange();
  first.$('#model-review-decision').value='APPROVE';first.$('#model-review-reason').value='Independent review of actual held-out score';first.$('#model-review-confirm').checked=true;
  first.$('#model-review-submit').onsubmit({preventDefault(){}});await first.settle();assert.equal(saved.size,1);
  assert.equal((await f.rows('PlusModelDecision')).totalCount,0,'Submitting human intent must not itself approve');
  const worker=createModelDecisionWorker({...f.options,servicesFor:f.servicesFor});t.after(()=>worker.close());
  const outcome=await worker.run();assert.equal(outcome.lastOutcome,'SUCCEEDED',JSON.stringify(outcome));
  f.setStorage(f.openStorage());const reopened=view(),before=calls.length;await reopened.jobs.lookup();assert.equal(calls.length,before+1);assert.equal(calls.at(-1).path,'/learning/decision-jobs/lookup');
  assert.equal(saved.size,0);assert.match(reopened.$('#decision-jobs').innerHTML,/SUCCEEDED/);
  const decisions=await f.rows('PlusModelDecision');assert.equal(decisions.totalCount,1);assert.equal(decisions.items[0].createdBy,owner.id);
  assert.equal(decisions.items[0].reason,'Independent review of actual held-out score');assert.equal((await f.rows('PlusDeployment')).totalCount,0);
  assert.equal(calls.filter(c=>c.path==='/learning/decision-jobs').length,1);assert.ok(calls.every(c=>!c.path.endsWith('/claim')&&!c.path.endsWith('/run')));
});

test('discovery intersects exact owner decision/job and evaluation read permissions, never broadens deployment scope',async t=>{
  const f=await fixture(t),read=()=>f.servicesFor().modelReview.read(owner);
  f.policy.modelGovernance.grants[0].permissions=['model:decision-read'];assert.deepEqual((await read()).keys,[]);
  f.policy.modelGovernance.grants[0].permissions=['model:decide'];f.policy.evaluation.grants[0].permissions=['evaluation:result-read'];assert.equal((await read()).items.length,0);
  f.policy.evaluation.grants[0].permissions=['evaluation:read'];assert.equal((await read()).items.length,0);
  f.policy.evaluation.grants[0].permissions=['evaluation:read','evaluation:result-read'];f.policy.recipeRead=false;
  await assert.rejects(read,/RECIPE_FORBIDDEN/);f.policy.recipeRead=true;
  await assert.rejects(()=>f.servicesFor().modelReview.read({...owner,tenantId:'other'}),/FORBIDDEN/);
  await assert.rejects(()=>f.servicesFor().modelReview.read({...owner,roles:['trainer']}),/FORBIDDEN/);
});

test('recorded evidence survives loss of current material qualification but revoked protocol disables new intent',async t=>{
  const f=await fixture(t);f.historyPolicy.validationAllowed=false;
  const before=await f.servicesFor().modelReview.read(owner);assert.equal(before.items[0].qualification,'NOT_CHECKED');
  await f.protocols.revoke(f.protocol._id,f.protocol._version,'withdrawn recorded protocol',owner);
  const after=await f.servicesFor().modelReview.read(owner);assert.equal(after.items.length,1);assert.equal(after.items[0].command,null);
  assert.ok(after.items[0].unavailableReasons.includes('PROTOCOL_CHANGED'));assert.ok(after.items[0].unavailableReasons.includes('EVALUATION_NOT_READY'));
});

test('different binding, task scope and time contract do not become review candidates',async t=>{
  const f=await fixture(t),target=f.policy.modelGovernance.targets[0].policy;
  for(const field of ['definitionHash','bindingHash','clockHash','scopeKey']){const original=target[field];target[field]=field==='scopeKey'?'other':'f'.repeat(64);
    assert.equal((await f.servicesFor().modelReview.read(owner)).items.length,0);target[field]=original;}
});

test('tampered score fingerprint and missing native typed links fail instead of becoming review evidence',async t=>{
  const f=await fixture(t),row=await f.storage.getObject(ctx,'PlusModelEvaluation',f.score.id);
  await f.storage.updateObject(ctx,'PlusModelEvaluation',row._id,{contentHash:'0'.repeat(64)},row._version);
  await assert.rejects(()=>f.servicesFor().modelReview.read(owner),/MODEL_EVALUATION_INTEGRITY/);
  const updated=await f.storage.getObject(ctx,'PlusModelEvaluation',f.score.id);await f.storage.updateObject(ctx,'PlusModelEvaluation',row._id,{contentHash:row.contentHash},updated._version);
  let injected=0;const original=f.storage;f.setStorage(new Proxy(original,{get(target,key){if(key==='getLinks')return async(...args)=>{
    if(args[1]===row._id&&args[2]==='PlusModelEvaluationRecipe'){injected++;return {items:[],totalCount:0,hasNextPage:false};}return target.getLinks(...args);};return Reflect.get(target,key);}}));
  await assert.rejects(()=>f.servicesFor().modelReview.read(owner),/MODEL_EVALUATION_LINK_INVALID/);assert.equal(injected,1);
});

test('metadata reads fence full identity/policy, native epoch, actual role and backward clocks',async t=>{
  const f=await fixture(t);let injected=0;
  f.setHook(({recipeConfig})=>{const authorize=recipeConfig.authorize;recipeConfig.authorize=async(...args)=>{const allowed=await authorize(...args);if(++injected===2)f.policy.unrelated='changed';return allowed;};});
  await assert.rejects(()=>f.servicesFor().modelReview.read(owner),/AUTHORITY_STALE/);assert.equal(injected,2);
  f.setHook(undefined);f.accounts[0].roles=['viewer'];f.save();await assert.rejects(()=>f.servicesFor().modelReview.read(owner),/FORBIDDEN/);
  f.accounts[0].roles=[...owner.roles];f.save();injected=0;
  f.setHook(({recipeConfig})=>{const authorize=recipeConfig.authorize;recipeConfig.authorize=async(...args)=>{const allowed=await authorize(...args);if(++injected===2){const row=await f.storage.getObject(ctx,'Machine',f.root._id);await f.storage.updateObject(ctx,'Machine',row._id,{priority:row.priority},row._version);}return allowed;};});
  await assert.rejects(()=>f.servicesFor().modelReview.read(owner),/CONFLICT/);assert.equal(injected,2);
  f.setHook(({recipeConfig})=>{let calls=0;const clock=recipeConfig.clock;recipeConfig.clock=()=>clock()-(++calls===2?1:0);});
  await assert.rejects(()=>f.servicesFor().modelReview.read(owner),/CLOCK_ORDER/);
});

test('collection overflow is explicit and result-source duplicates cannot silently omit candidates',async t=>{
  const f=await fixture(t),original=f.storage;let injected=0;
  f.setStorage(new Proxy(original,{get(target,key){if(key==='queryObjects')return async(...args)=>{const page=await target.queryObjects(...args);
    if(args[1]==='PlusModelEvaluation'){injected++;return {...page,items:[...page.items,...page.items],totalCount:page.items.length*2};}return page;};return Reflect.get(target,key);}}));
  await assert.rejects(()=>f.servicesFor().modelReview.read(owner),/COLLECTION_LIMIT/);assert.equal(injected,1);
});

test('shipped private gateway exposes strict read-only options and reauthenticates the exact revoked token',async t=>{
  const f=await fixture(t),handler=createPlusLearningHandler({tenantId:ctx.tenantId,authenticate:f.options.identities.authenticate,
    createServices:({reauthenticate})=>f.servicesFor(reauthenticate),recordFailure:async()=>{}});
  const server=createServer(async(req,res)=>{if(!await handler(req,res)){res.writeHead(404);res.end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const gateway=createAppServer({platformUrl:'http://127.0.0.1:'+server.address().port,platformApiPrefix:'/api/plus/v2'});await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
  t.after(async()=>{for(const s of [gateway,server]){s.closeAllConnections();await new Promise(r=>s.close(r));}});
  const request=async(path,method='GET')=>{const response=await fetch('http://127.0.0.1:'+gateway.address().port+'/api/learning'+path,{method,headers:{authorization:'Bearer '+f.token},signal:AbortSignal.timeout(10000)});return {status:response.status,body:await response.json()};};
  const result=await request('/decision-jobs/options');assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.body.data.items[0].score.id,f.score.id);
  assert.equal((await request('/decision-jobs/options?key='+f.key)).status,400);
  assert.equal((await request('/decision-jobs/options','POST')).status,404);
  f.accounts.push({...f.accounts[0],tokenHash:createHash('sha256').update('second-live-owner-token').digest('hex')});f.save();
  f.setHook(({recipeConfig})=>{const read=recipeConfig.authorize;let count=0;recipeConfig.authorize=async(...args)=>{if(++count===1){f.accounts[0].expiresAt='2020-01-01T00:00:00Z';f.save();}return read(...args);};});
  const denied=await request('/decision-jobs/options');assert.notEqual(denied.status,200);assert.equal((await f.rows('PlusModelDecision')).totalCount,0);
});

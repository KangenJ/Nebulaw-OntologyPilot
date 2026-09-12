import {readFileSync,existsSync,mkdirSync,openSync,writeSync,fsyncSync,closeSync,unlinkSync,renameSync} from 'node:fs';
import {join,dirname,resolve,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {digest} from '../../platform/packages/plus-contracts/dist/index.js';
import {NativeOntologyCatalog,NativeDefinitionRegistry,transitionComponentContract,transitionEvaluatorId,learnedCompositionStateEvaluatorId} from '../../platform/packages/plus-runtime/dist/index.js';
import {createNativeStorage} from '../../platform/apps/lwm-demo/src/native-storage.mjs';
import {taskEpisodeBinding} from '../../platform/domain-packs/lwm-plus/mechanisms/task-mechanism.mjs';
import {buildAuthoredTransitionRecipe} from '../../services/plus-engine/transition-authoring.mjs';
import {transitionEstimatorId} from '../../services/plus-engine/transition-fit.mjs';
import {compositionEstimatorId} from '../../services/plus-engine/native-composition-recipe.mjs';
import {learnedCompositionEstimatorId} from '../../services/plus-engine/learned-composition.mjs';
import {planNativeLearningPurpose} from './native-learning-purpose-plan.mjs';
import {createPrivateIdentityProvider} from './private-identity.mjs';
import {readBootstrapFile} from './native-domain-bootstrap.mjs';
import {readNativeRuntimeProfile,validateNativeRuntimeProfile} from './runtime-host.mjs';
import {inspectNativeDatabase} from './native-backup.mjs';
import {validateReviewedFitDeployment,assertReviewedFitPolicy} from './reviewed-fit-registration.mjs';

const fail=code=>{throw Object.assign(Error(code),{code});};
const shape=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const key=v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(v)&&!['constructor','prototype','__proto__'].includes(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const bytes=v=>JSON.stringify(v,null,2)+'\n',sha=v=>createHash('sha256').update(v).digest('hex'),fileHash=p=>sha(readFileSync(p));
const modelKeys=['component','model','componentEvaluation','initialEvaluation','updateEvaluation','transitionAuthorization','completeAuthorization'];
function request(raw){
  if(!shape(raw,['schema','learningRequest','recipeKeys','keys','workers','transition','trainingProtocolKeys','completeRevisions','clockMaxSteps'])
    ||raw.schema!=='plus-native-model-purpose-request-v1'||raw.learningRequest?.schema!=='plus-native-learning-purpose-request-v2'
    ||!shape(raw.recipeKeys,['observation','transition','complete'])||!Object.values(raw.recipeKeys).every(key)||new Set(Object.values(raw.recipeKeys)).size!==3
    ||!shape(raw.keys,modelKeys)||!Object.values(raw.keys).every(key)||new Set(Object.values(raw.keys)).size!==modelKeys.length
    ||!shape(raw.workers,['transition','complete','selection'])||!Object.values(raw.workers).every(key)||new Set(Object.values(raw.workers)).size!==3
    ||!Array.isArray(raw.trainingProtocolKeys)||!raw.trainingProtocolKeys.length||raw.trainingProtocolKeys.length>10||!raw.trainingProtocolKeys.every(key)||new Set(raw.trainingProtocolKeys).size!==raw.trainingProtocolKeys.length
    ||!Array.isArray(raw.completeRevisions)||!raw.completeRevisions.length||raw.completeRevisions.length>10||raw.completeRevisions.some(v=>!Number.isSafeInteger(v)||v<1)
    ||new Set(raw.completeRevisions).size!==raw.completeRevisions.length||!raw.completeRevisions.includes(1)
    ||!Number.isSafeInteger(raw.clockMaxSteps)||raw.clockMaxSteps<1||raw.clockMaxSteps>256
    ||!raw.transition||Object.hasOwn(raw.transition,'trainingProtocolHashes'))fail('MODEL_PURPOSE_REQUEST_INVALID');
  return structuredClone(raw);
}
function writeNew(path,value){const fd=openSync(path,'wx',0o600),data=Buffer.from(typeof value==='string'?value:bytes(value));try{let n=0;while(n<data.length)n+=writeSync(fd,data,n,data.length-n);fsyncSync(fd);}finally{closeSync(fd);}}
function sync(path){const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}

// First model configuration only, composed from current native definitions and
// reviewed prospective learning purposes. No test import, native approval row,
// model file, dataset membership, historical labels or service start.
export async function planNativeModelPurpose(raw){
  const input=request(raw),learning=await planNativeLearningPurpose(input.learningRequest),m=learning.material;
  const profile=readNativeRuntimeProfile(input.learningRequest.profilePath),policy=structuredClone(m.policy),identities=createPrivateIdentityProvider({authPath:profile.authPath,tenantId:profile.tenantId});
  identities.assertConfigured();
  if((m.inventory.objectsByType.PlusModelRelease??0)>0||(m.inventory.objectsByType.PlusDeployment??0)>0)fail('MODEL_PURPOSE_INITIAL_MODEL_REQUIRED');
  const people={};for(const [name,id]of Object.entries(input.learningRequest.principals))people[name]=await identities.resolvePrincipal(id);
  const workers={};for(const [name,id]of Object.entries(input.workers)){
    const p=await identities.resolvePrincipal(id),role=name==='selection'?'plus_governance_worker':'plus_compute_worker';
    if(p.tenantId!==profile.tenantId||p.roles.length!==1||p.roles[0]!==role||Object.values(people).some(v=>v.id===id))fail('MODEL_PURPOSE_DEDICATED_WORKER_REQUIRED');workers[name]=p;
  }
  if(policy.taskRules?.enabled!==true)fail('MODEL_PURPOSE_REVIEWED_RULE_CONFIGURATION_REQUIRED');
  const workspace=input.learningRequest.workspaceKey,collection=policy.taskLearning.feedback.find(e=>e.workspace===workspace)?.policy.collectionPolicyHash;
  for(const [name,engine]of [['observation',compositionEstimatorId],['transition',transitionEstimatorId],['complete',learnedCompositionEstimatorId]]){
    const entry=policy.taskLearning.recipes.find(e=>e.key===input.recipeKeys[name]&&e.workspace===workspace);
    if(!entry?.policy.engineIds.includes(engine)||!entry.policy.classifications.includes('SYNTHETIC')||!entry.policy.collectionPolicyHashes.includes(collection)
      ||!entry.policy.populationPolicyHashes.includes(input.transition.populationPolicyHash))fail('MODEL_PURPOSE_RECIPE_PURPOSE_REQUIRED');
    for(const p of [people.trainer,people.owner])if(!policy.taskLearning.grants.some(g=>g.principalId===p.id&&g.workspaces.includes(workspace)&&g.recipeKeys.includes(entry.key)&&g.permissions.includes('recipe:use')))
      fail('MODEL_PURPOSE_RECIPE_ACCESS_REQUIRED');
  }
  const protocols=input.trainingProtocolKeys.map(k=>{
    const c=policy.taskLearning.cohorts.find(e=>e.workspace===workspace&&e.protocol.key===k)?.protocol;
    if(!c||c.partition!=='TRAIN'||c.classification!=='SYNTHETIC'||c.definitionHash!==m.definitionReference.definitionHash||c.collectionPolicyHash!==collection
      ||Date.now()>=Date.parse(c.labelReceivedFrom))fail('MODEL_PURPOSE_PROSPECTIVE_TRAINING_REQUIRED');return c;
  });
  if(input.transition.classification!=='SYNTHETIC'||input.transition.collectionPolicyHash!==collection)fail('MODEL_PURPOSE_TRAINING_CONTRACT_MISMATCH');
  const storage=createNativeStorage(profile.dbPath);let compiled,bundle;
  try{
    const catalog=new NativeOntologyCatalog({storage,tenantId:profile.tenantId,authorize:async(p,permission)=>p.id===people.owner.id&&permission==='ontology:read'});
    bundle=(await catalog.read(people.owner)).bundle;if(bundle.contentHash!==m.ontologyHash)fail('MODEL_PURPOSE_SOURCE_CHANGED');
    const definitions=new NativeDefinitionRegistry({storage,catalog,tenantId:profile.tenantId,authorize:async(p,permission,k)=>p.id===people.owner.id&&permission==='definition:read'&&k===input.learningRequest.definitionKey,
      policyFor:async()=>policy.definitions[input.learningRequest.definitionKey].policy});
    const published=await definitions.requirePublished(input.learningRequest.definitionKey,people.owner);
    if(published.record._id!==m.definitionReference.id||published.record._version!==m.definitionReference.version||published.compiled.definitionHash!==m.definitionReference.definitionHash)fail('MODEL_PURPOSE_SOURCE_CHANGED');compiled=published.compiled;
  }finally{storage.close();}
  const transition=buildAuthoredTransitionRecipe(compiled,taskEpisodeBinding(),bundle,{...input.transition,trainingProtocolHashes:protocols.map(digest)});
  const component=transitionComponentContract(transition),clock={schema:'plus-fixed-step-clock-v1',definitionHash:compiled.definitionHash,bindingHash:component.bindingHash,
    stepMilliseconds:component.stepMs,maxSteps:input.clockMaxSteps,transitionContext:'INTERVAL_START',interventions:'WAIT_ONLY'};
  if(clock.maxSteps>component.maxSteps)fail('MODEL_PURPOSE_CLOCK_LIMIT');
  const selection={key:input.recipeKeys.complete,revision:1,engineId:learnedCompositionEstimatorId,definitionHash:compiled.definitionHash,bindingHash:component.bindingHash,scopeKey:component.scopeKey,classification:'SYNTHETIC'};
  const selections=input.completeRevisions.map(revision=>({...selection,revision})),k=input.keys,trainer=people.trainer,owner=people.owner;
  const grant=(p,keys,permissions)=>({principalId:p.id,requiredRoles:p.roles,keys,permissions});
  policy.modelGovernance={version:'plus-private-model-governance-v2',enabled:true,targets:[
    {key:k.component,policy:{version:'plus-transition-component-admission-v1',id:k.component,task:'CONDITIONAL_TRANSITION',definitionHash:component.definitionHash,bindingHash:component.bindingHash,scopeKey:component.scopeKey,classification:'SYNTHETIC',clockHash:component.timeContractHash,component}},
    {key:k.model,policy:{version:'plus-model-admission-v1',id:k.model,task:'STATE_ESTIMATION',definitionHash:compiled.definitionHash,bindingHash:component.bindingHash,scopeKey:component.scopeKey,classification:'SYNTHETIC',clockHash:digest(clock)}}],grants:[
    grant(owner,[k.component],['model:decide','model:decision-read','model:decision-use','model:decision-revoke']),
    grant(owner,[k.model],['model:decide','model:decision-read','model:decision-use','model:decision-revoke','deployment:activate','deployment:read','deployment:rollback']),
    grant(trainer,[k.component],['model:decision-read','model:decision-use']),grant(trainer,[k.model],['model:decision-read','model:decision-use','deployment:read'])]};
  const updates=selections.filter(v=>v.revision!==1).map(selection=>({selection,key:k.updateEvaluation+'.r'+selection.revision}));
  if(updates.some(v=>!key(v.key)))fail('MODEL_PURPOSE_EVALUATION_KEY_INVALID');
  const evaluations=[k.componentEvaluation,k.initialEvaluation,...updates.map(v=>v.key)];
  policy.evaluation={version:'plus-private-evaluation-v2',enabled:true,protocols:[
    {key:k.componentEvaluation,purpose:{version:'plus-evaluation-purpose-v1',id:k.componentEvaluation,recipeHashes:[digest(transition)],evaluatorIds:[transitionEvaluatorId],classifications:['SYNTHETIC']}},
    {key:k.initialEvaluation,purpose:{version:'plus-evaluation-purpose-v1',id:k.initialEvaluation,recipeSelections:[selection],evaluatorIds:[learnedCompositionStateEvaluatorId],classifications:['SYNTHETIC'],reference:{mode:'COLD_START',controlKey:k.model}}},
    ...updates.map(({key,selection})=>({key,purpose:{version:'plus-evaluation-purpose-v1',id:key,recipeSelections:[selection],evaluatorIds:[learnedCompositionStateEvaluatorId],classifications:['SYNTHETIC'],reference:{mode:'CURRENT_PUBLICATION',controlKey:k.model}}}))],
    grants:[{principalId:trainer.id,requiredRoles:trainer.roles,protocolKeys:evaluations,permissions:['evaluation:draft','evaluation:read','evaluation:use','evaluation:run','evaluation:result-read']},
      {principalId:owner.id,requiredRoles:owner.roles,protocolKeys:evaluations,permissions:['evaluation:review','evaluation:read','evaluation:use','evaluation:revoke','evaluation:result-read']}]};
  const pairs=[[workers.transition,k.transitionAuthorization,transitionEstimatorId],[workers.complete,k.completeAuthorization,learnedCompositionEstimatorId]],computeKeys=pairs.map(([,key])=>key);
  policy.computeAuthorizations={version:'plus-private-compute-authorizations-v1',enabled:true,targets:pairs.map(([worker,key,engineId])=>({key,policy:{version:'plus-compute-authorization-policy-v1',id:key,submitterId:trainer.id,
    workerId:worker.id,workerRoles:worker.roles,engineId,definitionHash:component.definitionHash,bindingHash:component.bindingHash,scopeKey:component.scopeKey,classification:'SYNTHETIC',leaseMs:300000,maxAttempts:2,maxDatasets:10}})),
    grants:[grant(trainer,computeKeys,['compute-authorization:propose','compute-authorization:read','compute-authorization:use']),grant(owner,computeKeys,['compute-authorization:review','compute-authorization:read','compute-authorization:revoke']),
      ...pairs.map(([p,key])=>grant(p,[key],['compute-authorization:read']))]};
  policy.compute={version:'plus-private-compute-v4',enabled:true,workers:pairs.map(([p])=>({principalId:p.id,requiredRoles:p.roles,maxItems:1})),
    grants:[grant(trainer,computeKeys,['compute:submit','compute:inspect','compute:read-result','compute:cancel']),grant(owner,computeKeys,['compute:inspect','compute:read-result','compute:cancel']),
      ...pairs.map(([p,key])=>grant(p,[key],['compute:inspect','compute:claim','compute:complete','compute:fail','compute:reconcile']))]};
  policy.selectionJobs={version:'plus-private-selection-jobs-v1',enabled:true,targets:[{key:k.model,policy:{version:'plus-selection-job-policy-v1',workerId:workers.selection.id,leaseMs:300000,maxAttempts:2}}],
    grants:[grant(owner,[k.model],['selection-job:enqueue','selection-job:read','selection-job:cancel']),grant(workers.selection,[k.model],['selection-job:read','selection-job:claim','selection-job:run','selection-job:fail','selection-job:reconcile'])]};
  // Empty access registries are intentional: later explicit episode-purpose
  // configuration is required. Enabling a service is not granting source use.
  for(const [name,version]of [['actionIntervals','plus-private-action-intervals-v1'],['replayGovernance','plus-private-replay-governance-v1'],['scenarioPlanning','plus-private-scenario-planning-v1'],['actionRequests','plus-private-action-requests-v1']])
    policy[name]={version,enabled:true,targets:[],grants:[]};
  policy.beliefRuntime={version:'plus-private-belief-runtime-v1',enabled:true,grants:[]};
  policy.learnedCompositionReplay={version:'plus-private-learned-composition-replay-v1',enabled:true,targets:[]};
  const deployment=validateReviewedFitDeployment({version:'plus-reviewed-native-fit-v1',tenantId:profile.tenantId,ontologyHash:m.ontologyHash,policyHash:digest(policy),recipeSelections:selections});assertReviewedFitPolicy(deployment,policy);
  const generatedProfile={...profile,schema:'plus-runtime-profile-v3',policyPath:join(m.target,'policy.json'),reviewedCompleteFit:{path:join(m.target,'reviewed-fit.json'),sha256:sha(bytes(deployment))},
    backgroundWorkers:{schema:'plus-native-worker-schedule-v1',audit:profile.backgroundWorkers?.audit??0,selection:0,evaluation:0,decision:0,actionExecution:0}};
  for(const p of [...Object.values(people),...Object.values(workers)])if(digest(await identities.resolvePrincipal(p.id))!==digest(p))fail('MODEL_PURPOSE_IDENTITY_CHANGED');
  if((await planNativeLearningPurpose(input.learningRequest)).planHash!==learning.planHash)fail('MODEL_PURPOSE_SOURCE_CHANGED');
  const material={request:input,target:m.target,pins:m.pins,inventory:m.inventory,ontologyHash:m.ontologyHash,definitionReference:m.definitionReference,policy,profile:generatedProfile,deployment,transitionRecipe:transition,clock};
  return {schema:'plus-native-model-purpose-plan-v1',planHash:digest(material),material,readOnly:true,nativeApprovalGranted:false,trainingStarted:false};
}

export async function applyNativeModelPurpose(plan,expectedHash){
  if(!shape(plan,['schema','planHash','material','readOnly','nativeApprovalGranted','trainingStarted'])||plan.schema!=='plus-native-model-purpose-plan-v1'||plan.readOnly!==true||plan.nativeApprovalGranted!==false||plan.trainingStarted!==false
    ||!hash(expectedHash)||plan.planHash!==expectedHash||digest(plan.material)!==expectedHash)fail('MODEL_PURPOSE_HASH_REQUIRED');
  const current=await planNativeModelPurpose(plan.material.request);if(current.planHash!==expectedHash)fail('MODEL_PURPOSE_STALE');
  const m=current.material,source=readNativeRuntimeProfile(m.request.learningRequest.profilePath),lock=source.dbPath+'.runtime.lock',marker=bytes({schema:'plus-model-purpose-lock-v1',pid:process.pid,nonce:randomUUID()});
  try{writeNew(lock,marker);}catch{fail('MODEL_PURPOSE_STOP_RUNTIME_FIRST');}
  try{
    if((await planNativeModelPurpose(m.request)).planHash!==expectedHash)fail('MODEL_PURPOSE_STALE');
    mkdirSync(m.target,{mode:0o700});writeNew(join(m.target,'policy.json'),m.policy);writeNew(join(m.target,'reviewed-fit.json'),m.deployment);
    writeNew(join(m.target,'transition-preview.json'),{recipeHash:digest(m.transitionRecipe),payload:m.transitionRecipe,nativeApprovalGranted:false});
    writeNew(join(m.target,'runtime.pending'),m.profile);validateNativeRuntimeProfile(m.profile);
    if(m.pins.profile!==fileHash(m.request.learningRequest.profilePath)||m.pins.auth!==fileHash(source.authPath)||m.pins.policy!==fileHash(source.policyPath)||digest(m.inventory)!==digest(inspectNativeDatabase(source.dbPath)))fail('MODEL_PURPOSE_SOURCE_CHANGED');
    const receipt={schema:'plus-native-model-purpose-installed-v1',planHash:expectedHash,profilePath:join(m.target,'runtime.json'),profileSha256:fileHash(join(m.target,'runtime.pending')),policySha256:fileHash(join(m.target,'policy.json')),
      reviewedFitSha256:m.profile.reviewedCompleteFit.sha256,ontologyHash:m.ontologyHash,definitionReference:m.definitionReference,transitionRecipeHash:digest(m.transitionRecipe),keys:m.request.keys,recipeKeys:m.request.recipeKeys,
      classification:'SYNTHETIC',sourceDatabaseChanged:false,credentialsChanged:false,originalPolicyChanged:false,nativeApprovalGranted:false,trainingStarted:false,serviceStarted:false,predictionReady:false,episodeAccessConfigured:false};
    writeNew(join(m.target,'installation.json'),receipt);renameSync(join(m.target,'runtime.pending'),receipt.profilePath);sync(m.target);return receipt;
  }finally{if(!existsSync(lock)||readFileSync(lock,'utf8')!==marker)fail('MODEL_PURPOSE_LOCK_RELEASE_UNCONFIRMED');unlinkSync(lock);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{const [op,path,arg]=process.argv.slice(2);if(process.argv.length!==5)fail('MODEL_PURPOSE_USAGE');
    if(op==='plan'){const plan=await planNativeModelPurpose(readBootstrapFile(path));
      if(!isAbsolute(arg)||dirname(arg)!==plan.material.request.learningRequest.outputParent)fail('MODEL_PURPOSE_PLAN_DIRECTORY_REQUIRED');writeNew(arg,plan);sync(dirname(arg));process.stdout.write(JSON.stringify({schema:plan.schema,planHash:plan.planHash,readOnly:true,nativeApprovalGranted:false,trainingStarted:false})+'\n');}
    else if(op==='apply')process.stdout.write(JSON.stringify(await applyNativeModelPurpose(readBootstrapFile(path),arg))+'\n');else fail('MODEL_PURPOSE_USAGE');
  }catch(e){process.stdout.write(JSON.stringify({schema:'plus-native-model-purpose-error-v1',code:/^(MODEL_PURPOSE_|LEARNING_PURPOSE_|TRANSITION_)/.test(e?.code??'')?e.code:'MODEL_PURPOSE_FAILED',credentialsIncluded:false,serviceStarted:false})+'\n');process.exitCode=2;}
}

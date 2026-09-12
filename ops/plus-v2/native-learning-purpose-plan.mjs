import {readFileSync,lstatSync,realpathSync,existsSync,mkdirSync,openSync,writeSync,fsyncSync,closeSync,unlinkSync,renameSync} from 'node:fs';
import {resolve,isAbsolute,dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {digest} from '../../platform/packages/plus-contracts/dist/index.js';
import {NativeOntologyCatalog,NativeDefinitionRegistry} from '../../platform/packages/plus-runtime/dist/index.js';
import {createNativeStorage} from '../../platform/apps/lwm-demo/src/native-storage.mjs';
import {assertInitialLearningConfiguration} from './initial-learning-configuration.mjs';
import {createPrivateIdentityProvider} from './private-identity.mjs';
import {readBootstrapFile} from './native-domain-bootstrap.mjs';
import {readNativeRuntimeProfile,validateNativeRuntimeProfile} from './runtime-host.mjs';
import {inspectNativeDatabase} from './native-backup.mjs';
import {registeredFitEngineIds} from '../../services/plus-engine/private-fit-registry.mjs';
import {learnedCompositionEstimatorId} from '../../services/plus-engine/learned-composition.mjs';
import {compositionEstimatorId} from '../../services/plus-engine/native-composition-recipe.mjs';
import {validateTaskLearningPolicy} from '../../platform/apps/lwm-demo/src/task-learning.mjs';
import {validatePrivateTaskRulePolicy} from './task-rule-services.mjs';
import {readReviewedFitDeployment,validateReviewedFitDeployment,assertReviewedFitPolicy} from './reviewed-fit-registration.mjs';

const fail=code=>{throw Object.assign(Error(code),{code});};
const shape=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const key=v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(v)&&!['__proto__','constructor','prototype'].includes(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const bytes=v=>JSON.stringify(v,null,2)+'\n',fileHash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
// Reuse the fixed recipe/FIT registry, including the rule/observation
// intermediate required by the complete model. This is a purpose allowlist,
// not job admission: the full model still needs its reviewed runtime pins.
const engines=Object.freeze([...registeredFitEngineIds,learnedCompositionEstimatorId]);
const time=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
function privateParent(path){
  if(process.platform!=='linux'||typeof path!=='string'||!isAbsolute(path)||/[\x00-\x1f\x7f]/.test(path))fail('LEARNING_PURPOSE_PRIVATE_PARENT_REQUIRED');
  let s;try{s=lstatSync(path);}catch{fail('LEARNING_PURPOSE_PRIVATE_PARENT_REQUIRED');}
  if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077)!==0||realpathSync(path)!==resolve(path))fail('LEARNING_PURPOSE_PRIVATE_PARENT_REQUIRED');return resolve(path);
}
function request(raw){
  const reviewed=raw?.schema==='plus-native-learning-purpose-request-v3',incremental=reviewed||raw?.schema==='plus-native-learning-purpose-request-v2';
  if(!shape(raw,['schema','profilePath','outputParent','directoryName','definitionKey','expectedDefinitionHash','workspaceKey','targetVariable','principals','cohorts','recipes',...(incremental?['groups']:[]),...(reviewed?['expectedReviewedFitSha256']:[])])
    ||!['plus-native-learning-purpose-request-v1','plus-native-learning-purpose-request-v2','plus-native-learning-purpose-request-v3'].includes(raw.schema)||typeof raw.profilePath!=='string'||!isAbsolute(raw.profilePath)
    ||![raw.definitionKey,raw.workspaceKey,raw.targetVariable,raw.directoryName].every(key)||!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(raw.directoryName)||!hash(raw.expectedDefinitionHash)
    ||!shape(raw.principals,['trainer','reviewer','owner'])||!Object.values(raw.principals).every(key)||new Set(Object.values(raw.principals)).size!==3
    ||!Array.isArray(raw.cohorts)||(!incremental&&raw.cohorts.length<1)||raw.cohorts.length>32||new Set(raw.cohorts.map(c=>c?.key)).size!==raw.cohorts.length
    ||!Array.isArray(raw.recipes)||(!incremental&&raw.recipes.length<1)||raw.recipes.length>32||new Set(raw.recipes.map(r=>r?.key)).size!==raw.recipes.length)fail('LEARNING_PURPOSE_REQUEST_INVALID');
  if(reviewed&&!hash(raw.expectedReviewedFitSha256))fail('LEARNING_PURPOSE_REVIEWED_PIN_REQUIRED');
  if(incremental&&(!Array.isArray(raw.groups)||raw.groups.length>100
    ||new Set(raw.groups.map(g=>g?.matterId)).size!==raw.groups.length
    ||raw.groups.some(g=>!shape(g,['matterId','expectedVersion'])||typeof g.matterId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(g.matterId)||!Number.isSafeInteger(g.expectedVersion)||g.expectedVersion<1)))fail('LEARNING_PURPOSE_GROUPS_INVALID');
  if(incremental&&!raw.groups.length&&!raw.cohorts.length&&!raw.recipes.length)fail('LEARNING_PURPOSE_EMPTY_INCREMENT');
  for(const c of raw.cohorts){
    if(!shape(c,['key','partition','inputVisibleFrom','inputVisibleUntil','labelReceivedFrom','labelReceivedUntil','approvalUntil','expectedSampleCount','minimumSamples','minimumCoverage'])||!key(c.key)
      ||!['TRAIN','VALIDATION','FINAL_EVAL'].includes(c.partition)||!['inputVisibleFrom','inputVisibleUntil','labelReceivedFrom','labelReceivedUntil','approvalUntil'].every(k=>time(c[k]))
      ||c.inputVisibleFrom>c.inputVisibleUntil||c.inputVisibleUntil>=c.labelReceivedFrom||c.labelReceivedFrom>=c.labelReceivedUntil||c.labelReceivedUntil>c.approvalUntil
      ||!Number.isSafeInteger(c.expectedSampleCount)||c.expectedSampleCount<1||c.expectedSampleCount>100||!Number.isSafeInteger(c.minimumSamples)||c.minimumSamples<1||c.minimumSamples>c.expectedSampleCount
      ||!Number.isFinite(c.minimumCoverage)||c.minimumCoverage<0||c.minimumCoverage>1)fail('LEARNING_PURPOSE_COHORT_INVALID');
    if(Date.now()>=Date.parse(c.labelReceivedFrom))fail('LEARNING_PURPOSE_PROSPECTIVE_WINDOW_REQUIRED');
  }
  for(const r of raw.recipes)if(!shape(r,['key','purposeId','engineId','populationPolicyHash'])||![r.key,r.purposeId].every(key)||!engines.includes(r.engineId)||!hash(r.populationPolicyHash))fail('LEARNING_PURPOSE_RECIPE_INVALID');
  return {...structuredClone(raw),outputParent:privateParent(raw.outputParent)};
}
function sync(path){const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
function writeNew(path,value){const fd=openSync(path,'wx',0o600),data=Buffer.from(typeof value==='string'?value:bytes(value));
  try{let n=0;while(n<data.length)n+=writeSync(fd,data,n,data.length-n);fsyncSync(fd);}finally{closeSync(fd);}sync(dirname(path));}

// Operator configuration only. Native cohort membership, qualified feedback,
// recipe review, compute authorization and model admission remain separate.
// No fixture import, outcome selection, partition reseeding, token or DB writes.
export async function planNativeLearningPurpose(raw){
  const input=request(raw),profile=readNativeRuntimeProfile(input.profilePath),target=join(input.outputParent,input.directoryName);
  // Existing callers remain initial-only. Reviewed increments require an
  // explicit request version AND the exact current private FIT capability.
  const reviewed=input.schema==='plus-native-learning-purpose-request-v3';
  if(reviewed?!['plus-runtime-profile-v2','plus-runtime-profile-v3'].includes(profile.schema):!['plus-runtime-profile-v1','plus-runtime-profile-v4'].includes(profile.schema))
    fail(reviewed?'LEARNING_PURPOSE_REVIEWED_RUNTIME_REQUIRED':'LEARNING_PURPOSE_INITIAL_RUNTIME_REQUIRED');
  if(existsSync(target))fail('LEARNING_PURPOSE_TARGET_EXISTS');
  const pins={profile:fileHash(input.profilePath),auth:fileHash(profile.authPath),policy:fileHash(profile.policyPath)},inventory=inspectNativeDatabase(profile.dbPath),policy=readBootstrapFile(profile.policyPath);
  let originalDeployment;
  if(reviewed){
    if(input.expectedReviewedFitSha256!==profile.reviewedCompleteFit.sha256)fail('LEARNING_PURPOSE_REVIEWED_PIN_REQUIRED');
    originalDeployment=readReviewedFitDeployment(profile.reviewedCompleteFit);assertReviewedFitPolicy(originalDeployment,policy);
    pins.reviewedFit=fileHash(profile.reviewedCompleteFit.path);
  }
  const assertConfiguration=value=>{
    if(!reviewed)return assertInitialLearningConfiguration(value);
    validateTaskLearningPolicy(value.taskLearning);validatePrivateTaskRulePolicy(value);
    // Only taskLearning changes. The original execution graph remains pinned,
    // not rebuilt or enabled by this entry point; full host checks still apply.
    assertReviewedFitPolicy({...originalDeployment,policyHash:digest(value)},value);
  };
  if(policy.taskLearning?.enabled!==true||policy.taskDomain?.enabled!==true||policy.taskDomain.workspaceClassifications?.[input.workspaceKey]!=='SYNTHETIC')fail('LEARNING_PURPOSE_SYNTHETIC_LEARNING_REQUIRED');
  // Do not publish a configuration that the real control host cannot start.
  // Rules are an independently governed prerequisite, never enabled here with
  // empty grants, seeded sources or synthetic approval just to allow a recipe.
  if(input.recipes.some(r=>[compositionEstimatorId,learnedCompositionEstimatorId].includes(r.engineId))&&policy.taskRules?.enabled!==true)fail('LEARNING_PURPOSE_RULE_CONFIGURATION_REQUIRED');
  const identities=createPrivateIdentityProvider({authPath:profile.authPath,tenantId:profile.tenantId}),principals={};identities.assertConfigured();
  for(const [name,role]of [['trainer','trainer'],['reviewer','data_reviewer'],['owner','model_owner']]){
    const p=await identities.resolvePrincipal(input.principals[name]);if(p.tenantId!==profile.tenantId||!p.roles.includes(role))fail('LEARNING_PURPOSE_ROLE_REQUIRED');principals[name]=p;
    if(!policy.taskDomain.episodeGrants?.some(g=>g.principalId===p.id&&g.workspaces.includes(input.workspaceKey)&&g.permissions.includes('episode:read')))fail('LEARNING_PURPOSE_SOURCE_ACCESS_REQUIRED');
  }
  const originalLearning=structuredClone(policy.taskLearning),feedback=originalLearning.feedback.find(f=>f.workspace===input.workspaceKey)?.policy;
  if((input.groups??[]).some(g=>originalLearning.groups.some(old=>old.matterId===g.matterId)))fail('LEARNING_PURPOSE_EXISTING_GROUPS_PRESERVED');
  if(!feedback?.classifications.includes('SYNTHETIC')||!feedback.variables.includes(input.targetVariable)||!hash(feedback.collectionPolicyHash))fail('LEARNING_PURPOSE_FEEDBACK_CONTRACT_REQUIRED');
  if(input.cohorts.some(c=>originalLearning.cohorts.some(e=>e.protocol.key===c.key))||input.recipes.some(r=>originalLearning.recipes.some(e=>e.key===r.key)))fail('LEARNING_PURPOSE_EXISTING_KEYS_PRESERVED');
  const storage=createNativeStorage(profile.dbPath),ctx={tenantId:profile.tenantId};let definitionReference,ontologyHash,scopeKey;
  try{
    assertConfiguration(policy);
    const catalog=new NativeOntologyCatalog({storage,tenantId:profile.tenantId,authorize:async(p,permission)=>p.id===principals.owner.id&&permission==='ontology:read'});
    const current=await catalog.read(principals.owner);ontologyHash=current.bundle.contentHash;if(ontologyHash!==profile.expectedOntologyHash)fail('LEARNING_PURPOSE_ONTOLOGY_MISMATCH');
    const entry=Object.hasOwn(policy.definitions,input.definitionKey)?policy.definitions[input.definitionKey]:undefined;
    if(!entry||Object.values(principals).some(p=>!p.roles.some(r=>entry.readRoles.includes(r))))fail('LEARNING_PURPOSE_DEFINITION_READ_REQUIRED');
    const definitions=new NativeDefinitionRegistry({storage,catalog,tenantId:profile.tenantId,authorize:async(p,permission,k)=>p.id===principals.owner.id&&permission==='definition:read'&&k===input.definitionKey,policyFor:async()=>entry.policy});
    const published=await definitions.requirePublished(input.definitionKey,principals.owner),compiled=published.compiled;
    const variable=compiled.variables.find(v=>v.key===input.targetVariable);
    if(compiled.definitionHash!==input.expectedDefinitionHash||compiled.definition.rootType!=='InvestigationTask'||variable?.role!=='LATENT'||variable.verification?.mode!=='GOLD')fail('LEARNING_PURPOSE_DEFINITION_MISMATCH');
    scopeKey=compiled.definition.scope.key;definitionReference={id:published.record._id,version:published.record._version,definitionHash:compiled.definitionHash,compiledHash:published.record.compiledHash};
    // Explicit new native parents only. Preserve all historical aliases and
    // the fixed partition seed/boundaries; neither outcomes nor desired folds
    // are accepted from the caller. Later feedback/FIT gates remain separate.
    for(const group of input.groups??[]){
      const matter=await storage.getObject(ctx,'Matter',group.matterId);
      if(!matter||matter._deletedAt||matter._tenantId!==profile.tenantId||matter.workspaceKey!==input.workspaceKey||matter._version!==group.expectedVersion)
        fail('LEARNING_PURPOSE_GROUP_CHANGED_OR_FORBIDDEN');
    }
    const cohorts=input.cohorts.map(c=>({workspace:input.workspaceKey,protocol:{version:'plus-cohort-v1',...c,definitionHash:compiled.definitionHash,variable:input.targetVariable,classification:'SYNTHETIC',collectionPolicyHash:feedback.collectionPolicyHash}}));
    const recipes=input.recipes.map(r=>({workspace:input.workspaceKey,key:r.key,policy:{version:'plus-recipe-policy-v1',id:r.purposeId,engineIds:[r.engineId],classifications:['SYNTHETIC'],collectionPolicyHashes:[feedback.collectionPolicyHash],populationPolicyHashes:[r.populationPolicyHash],scopeKeys:[scopeKey]}}));
    const common=['cohort:read','dataset:inspect','recipe:read'];
    const permissions={trainer:[...common,'cohort:propose','dataset:freeze','dataset:FIT','dataset:VALIDATE','dataset:FINAL_EVALUATE','recipe:draft','recipe:use'],reviewer:[...common,'cohort:review'],owner:[...common,'dataset:FIT','dataset:VALIDATE','dataset:FINAL_EVALUATE','recipe:review','recipe:revoke','recipe:use']};
    // New isolated grant rows, never broaden existing keys/workspaces by merging
    // permission arrays into an existing row (which would create a cross-product).
    const grants=cohorts.length||recipes.length?Object.entries(principals).map(([name,p])=>({principalId:p.id,requiredRoles:[{trainer:'trainer',reviewer:'data_reviewer',owner:'model_owner'}[name]],workspaces:[input.workspaceKey],
      permissions:permissions[name].filter(permission=>permission.startsWith('recipe:')?recipes.length>0:cohorts.length>0),
      protocolKeys:cohorts.map(c=>c.protocol.key),recipeKeys:recipes.map(r=>r.key),types:{InvestigationTask:{read:['workspaceKey']},Matter:{read:['workspaceKey']}}})):[];
    policy.taskLearning={...originalLearning,groups:[...originalLearning.groups,...(input.groups??[]).map(g=>({matterId:g.matterId,workspace:input.workspaceKey,aliases:[]}))],
      cohorts:[...originalLearning.cohorts,...cohorts],recipes:[...originalLearning.recipes,...recipes],grants:[...originalLearning.grants,...grants]};
    assertConfiguration(policy);
  }finally{storage.close();}
  for(const p of Object.values(principals))if(digest(await identities.resolvePrincipal(p.id))!==digest(p))fail('LEARNING_PURPOSE_IDENTITY_CHANGED');
  request(input);
  if(pins.profile!==fileHash(input.profilePath)||pins.auth!==fileHash(profile.authPath)||pins.policy!==fileHash(profile.policyPath)
    ||reviewed&&pins.reviewedFit!==fileHash(profile.reviewedCompleteFit.path)||digest(inventory)!==digest(inspectNativeDatabase(profile.dbPath)))fail('LEARNING_PURPOSE_SOURCE_CHANGED');
  const deployment=reviewed?validateReviewedFitDeployment({...originalDeployment,policyHash:digest(policy)}):undefined;
  const generatedProfile={...profile,policyPath:join(target,'policy.json'),...(deployment?{reviewedCompleteFit:{path:join(target,'reviewed-fit.json'),sha256:createHash('sha256').update(bytes(deployment)).digest('hex')}}:{})};
  const material={request:input,target,pins,inventory,ontologyHash,definitionReference,scopeKey,policy,profile:generatedProfile,...(deployment?{deployment}:{})};
  return {schema:'plus-native-learning-purpose-plan-v1',planHash:digest(material),material,readOnly:true,nativeApprovalGranted:false,trainingStarted:false};
}

export async function applyNativeLearningPurpose(plan,expectedHash){
  if(!shape(plan,['schema','planHash','material','readOnly','nativeApprovalGranted','trainingStarted'])||plan.schema!=='plus-native-learning-purpose-plan-v1'||plan.readOnly!==true||plan.nativeApprovalGranted!==false||plan.trainingStarted!==false
    ||!hash(expectedHash)||plan.planHash!==expectedHash||digest(plan.material)!==expectedHash)fail('LEARNING_PURPOSE_HASH_REQUIRED');
  const current=await planNativeLearningPurpose(plan.material.request);if(current.planHash!==expectedHash)fail('LEARNING_PURPOSE_STALE');
  const m=current.material,source=readNativeRuntimeProfile(m.request.profilePath),lock=source.dbPath+'.runtime.lock',lockBytes=bytes({schema:'plus-learning-purpose-lock-v1',pid:process.pid,nonce:randomUUID()});
  try{writeNew(lock,lockBytes);}catch{fail('LEARNING_PURPOSE_STOP_RUNTIME_FIRST');}
  try{
    if((await planNativeLearningPurpose(m.request)).planHash!==expectedHash)fail('LEARNING_PURPOSE_STALE');
    mkdirSync(m.target,{mode:0o700});writeNew(join(m.target,'policy.json'),m.policy);if(m.deployment)writeNew(join(m.target,'reviewed-fit.json'),m.deployment);
    writeNew(join(m.target,'runtime.pending'),m.profile);validateNativeRuntimeProfile(m.profile);
    if(m.pins.profile!==fileHash(m.request.profilePath)||m.pins.auth!==fileHash(source.authPath)||m.pins.policy!==fileHash(source.policyPath)
      ||m.pins.reviewedFit&&m.pins.reviewedFit!==fileHash(source.reviewedCompleteFit.path)||digest(m.inventory)!==digest(inspectNativeDatabase(source.dbPath)))fail('LEARNING_PURPOSE_SOURCE_CHANGED');
    const receipt={schema:'plus-native-learning-purpose-installed-v1',planHash:expectedHash,profilePath:join(m.target,'runtime.json'),profileSha256:fileHash(join(m.target,'runtime.pending')),policySha256:fileHash(join(m.target,'policy.json')),
      ontologyHash:m.ontologyHash,definitionReference:m.definitionReference,cohortKeys:m.request.cohorts.map(c=>c.key),recipeKeys:m.request.recipes.map(r=>r.key),
      ...(m.request.schema!=='plus-native-learning-purpose-request-v1'?{addedGroupCount:m.request.groups.length,existingGroupsPreserved:true,partitionPolicyUnchanged:true}:{}),
      ...(m.deployment?{reviewedFitSha256:m.profile.reviewedCompleteFit.sha256,recipeSelectionAllowlistUnchanged:true,computeAuthorizationsUnchanged:true,backgroundScheduleUnchanged:true}:{}),
      classification:'SYNTHETIC',sourceDatabaseChanged:false,credentialsChanged:false,originalPolicyChanged:false,nativeApprovalGranted:false,trainingStarted:false,serviceStarted:false,predictionReady:false};
    writeNew(join(m.target,'installation.json'),receipt);renameSync(join(m.target,'runtime.pending'),receipt.profilePath);sync(m.target);return receipt;
  }finally{if(!existsSync(lock)||readFileSync(lock,'utf8')!==lockBytes)fail('LEARNING_PURPOSE_LOCK_RELEASE_UNCONFIRMED');unlinkSync(lock);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{const [operation,path,arg]=process.argv.slice(2);if(process.argv.length!==5)fail('LEARNING_PURPOSE_USAGE');
    if(operation==='plan'){privateParent(dirname(arg));const plan=await planNativeLearningPurpose(readBootstrapFile(path));writeNew(arg,plan);process.stdout.write(JSON.stringify({schema:plan.schema,planHash:plan.planHash,readOnly:true,nativeApprovalGranted:false,trainingStarted:false})+'\n');}
    else if(operation==='apply')process.stdout.write(JSON.stringify(await applyNativeLearningPurpose(readBootstrapFile(path),arg))+'\n');else fail('LEARNING_PURPOSE_USAGE');
  }catch(e){process.stdout.write(JSON.stringify({schema:'plus-native-learning-purpose-error-v1',code:/^LEARNING_PURPOSE_/.test(e?.code??'')?e.code:'LEARNING_PURPOSE_FAILED',credentialsIncluded:false,serviceStarted:false})+'\n');process.exitCode=2;}
}

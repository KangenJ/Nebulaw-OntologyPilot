import {readFileSync,lstatSync,realpathSync,existsSync,mkdirSync,openSync,writeSync,fsyncSync,closeSync,unlinkSync,renameSync} from 'node:fs';
import {resolve,isAbsolute,dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {digest,variableTimeFields} from '../../platform/packages/plus-contracts/dist/index.js';
import {NativeOntologyCatalog,NativeDefinitionRegistry} from '../../platform/packages/plus-runtime/dist/index.js';
import {createNativeStorage} from '../../platform/apps/lwm-demo/src/native-storage.mjs';
import {taskGroupingPolicyHash} from '../../platform/apps/lwm-demo/src/task-learning.mjs';
import {taskEpisodeBinding} from '../../platform/domain-packs/lwm-plus/mechanisms/task-mechanism.mjs';
import {createPrivateTaskServices} from './task-services.mjs';
import {createPrivateIdentityProvider} from './private-identity.mjs';
import {readBootstrapFile} from './native-domain-bootstrap.mjs';
import {readNativeRuntimeProfile,validateNativeRuntimeProfile} from './runtime-host.mjs';
import {inspectNativeDatabase} from './native-backup.mjs';

const fail=code=>{throw Object.assign(Error(code),{code});};
const shape=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const key=v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(v)&&!['__proto__','constructor','prototype'].includes(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const bytes=v=>JSON.stringify(v,null,2)+'\n',fileHash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
function privateParent(path){
  if(process.platform!=='linux'||typeof path!=='string'||!isAbsolute(path)||/[\x00-\x1f\x7f]/.test(path))fail('LEARNING_PLAN_PRIVATE_PARENT_REQUIRED');
  let s;try{s=lstatSync(path);}catch{fail('LEARNING_PLAN_PRIVATE_PARENT_REQUIRED');}
  if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077)!==0||realpathSync(path)!==resolve(path))fail('LEARNING_PLAN_PRIVATE_PARENT_REQUIRED');return resolve(path);
}
function request(raw){
  if(!shape(raw,['schema','profilePath','outputParent','directoryName','definitionKey','expectedDefinitionHash','workspaceKey','targetVariable','principals','groups','feedback','partition'])
    ||raw.schema!=='plus-native-learning-access-request-v1'||typeof raw.profilePath!=='string'||!isAbsolute(raw.profilePath)
    ||![raw.definitionKey,raw.workspaceKey,raw.targetVariable].every(key)||!hash(raw.expectedDefinitionHash)
    ||!key(raw.directoryName)||!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(raw.directoryName)
    ||!shape(raw.principals,['trainer','reviewer','owner'])||!Object.values(raw.principals).every(key)||new Set(Object.values(raw.principals)).size!==3
    ||!shape(raw.feedback,['key','collectionPolicyHash','minimumMaturityMs'])||!key(raw.feedback.key)||!hash(raw.feedback.collectionPolicyHash)
    ||!Number.isSafeInteger(raw.feedback.minimumMaturityMs)||raw.feedback.minimumMaturityMs<0||raw.feedback.minimumMaturityMs>31536000000
    ||!shape(raw.partition,['seed','boundaries'])||!key(raw.partition.seed)||!Array.isArray(raw.partition.boundaries)||raw.partition.boundaries.length!==4
    ||raw.partition.boundaries[3]!==10000||raw.partition.boundaries.some((n,i,a)=>!Number.isSafeInteger(n)||n<1||i>0&&n<=a[i-1])
    ||!Array.isArray(raw.groups)||raw.groups.length<1||raw.groups.length>100||new Set(raw.groups.map(g=>g?.matterId)).size!==raw.groups.length
    ||raw.groups.some(g=>!shape(g,['matterId','expectedVersion'])||typeof g.matterId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(g.matterId)||!Number.isSafeInteger(g.expectedVersion)||g.expectedVersion<1))fail('LEARNING_PLAN_REQUEST_INVALID');
  return {...structuredClone(raw),outputParent:privateParent(raw.outputParent)};
}
function writeNew(path,value){const data=Buffer.from(typeof value==='string'?value:bytes(value)),fd=openSync(path,'wx',0o600);
  try{let n=0;while(n<data.length)n+=writeSync(fd,data,n,data.length-n);fsyncSync(fd);}finally{closeSync(fd);}sync(dirname(path));}
function sync(path){const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}

// First normal learning access installation, not a complete-model purpose
// generator. No experimental fixture import, token creation, data/GOLD seed,
// FIT grant, recipe, cohort, evaluation or model approval is generated.
export async function planNativeLearningAccess(raw){
  const input=request(raw),profile=readNativeRuntimeProfile(input.profilePath),target=join(input.outputParent,input.directoryName);
  if(profile.schema!=='plus-runtime-profile-v1')fail('LEARNING_PLAN_INITIAL_PROFILE_REQUIRED');
  if(existsSync(target))fail('LEARNING_PLAN_TARGET_EXISTS');
  const pins={profile:fileHash(input.profilePath),auth:fileHash(profile.authPath),policy:fileHash(profile.policyPath)},inventory=inspectNativeDatabase(profile.dbPath);
  const policy=readBootstrapFile(profile.policyPath);
  if(policy.taskLearning!==undefined||policy.taskDomain?.episodeGrants!==undefined||Object.keys(policy).some(k=>!['version','definitions','taskDomain','objectBrowser'].includes(k)))fail('LEARNING_PLAN_EXISTING_AUTHORITY_PRESERVED');
  if(policy.taskDomain?.enabled!==true||policy.taskDomain.workspaceClassifications?.[input.workspaceKey]!=='SYNTHETIC')fail('LEARNING_PLAN_SYNTHETIC_SCOPE_REQUIRED');
  const identities=createPrivateIdentityProvider({authPath:profile.authPath,tenantId:profile.tenantId}),principals={};identities.assertConfigured();
  for(const [name,role]of [['trainer','trainer'],['reviewer','data_reviewer'],['owner','model_owner']]){
    const p=await identities.resolvePrincipal(input.principals[name]);if(p.tenantId!==profile.tenantId||!p.roles.includes(role))fail('LEARNING_PLAN_ROLE_REQUIRED');
    principals[name]={id:p.id,tenantId:p.tenantId,roles:[role]};
  }
  const storage=createNativeStorage(profile.dbPath),ctx={tenantId:profile.tenantId};let compiled,definitionReference,ontologyHash,episodeFields;
  try{
    const catalog=new NativeOntologyCatalog({storage,tenantId:profile.tenantId,authorize:async(p,permission)=>p.id===principals.owner.id&&permission==='ontology:read'});
    const current=await catalog.read(principals.owner);ontologyHash=current.bundle.contentHash;
    if(ontologyHash!==profile.expectedOntologyHash)fail('LEARNING_PLAN_ONTOLOGY_MISMATCH');
    const entry=Object.hasOwn(policy.definitions,input.definitionKey)?policy.definitions[input.definitionKey]:undefined;
    if(!entry||Object.values(principals).some(p=>!p.roles.some(r=>entry.readRoles.includes(r))))fail('LEARNING_PLAN_DEFINITION_READ_REQUIRED');
    const definitions=new NativeDefinitionRegistry({storage,catalog,tenantId:profile.tenantId,authorize:async(p,permission,k)=>p.id===principals.owner.id&&permission==='definition:read'&&k===input.definitionKey,policyFor:async()=>entry.policy});
    const published=await definitions.requirePublished(input.definitionKey,principals.owner);compiled=published.compiled;
    if(compiled.definitionHash!==input.expectedDefinitionHash||compiled.definition.rootType!=='InvestigationTask')fail('LEARNING_PLAN_DEFINITION_MISMATCH');
    const variable=compiled.variables.find(v=>v.key===input.targetVariable);
    if(variable?.role!=='LATENT'||variable.verification?.mode!=='GOLD'||!Object.values(policy.taskDomain.verificationMethods??{}).some(v=>v.policyRef===variable.verification.policyRef&&v.mode==='GOLD'&&v.classifications.includes('SYNTHETIC')))fail('LEARNING_PLAN_SUPERVISION_REQUIRED');
    definitionReference={id:published.record._id,version:published.record._version,definitionHash:compiled.definitionHash,compiledHash:published.record.compiledHash};
    for(const g of input.groups){const matter=await storage.getObject(ctx,'Matter',g.matterId);
      if(!matter||matter._deletedAt||matter._tenantId!==ctx.tenantId||matter.workspaceKey!==input.workspaceKey||matter._version!==g.expectedVersion)fail('LEARNING_PLAN_GROUP_CHANGED_OR_FORBIDDEN');}
    // Exact current compiled variable/time fields plus native source contract,
    // not all columns, legal experimental vectors or inferred causal edges.
    const fields={},add=(type,names)=>{fields[type]=[...new Set([...(fields[type]??[]),...names])].sort();},binding=taskEpisodeBinding();
    add(binding.rootType,['workspaceKey',binding.classificationField]);
    for(const v of compiled.variables)add(v.source.objectType,[v.source.field,...variableTimeFields(v)]);
    for(const s of binding.sources)add(s.sourceType,[s.valueField,s.eventTimeField,s.receivedTimeField,...s.qualificationFields]);
    for(const [type,names]of Object.entries(fields)){
      if(!['InvestigationTask','Observation','TaskCompletionVerification'].includes(type))fail('LEARNING_PLAN_SOURCE_TYPE_UNSUPPORTED');
      for(const name of names){const f=current.bundle.parsed.objectTypes.find(t=>t.name===type)?.fields.find(f=>f.name===name);
        if(!f||f.directives.some(d=>['primary','computed','link'].includes(d.kind)))fail('LEARNING_PLAN_FIELD_CONTRACT_CHANGED');}
    }
    episodeFields=Object.fromEntries(Object.entries(fields).map(([type,read])=>[type,{read}]));
    policy.taskDomain.episodeGrants=Object.values(principals).map(p=>({principalId:p.id,workspaces:[input.workspaceKey],permissions:['episode:open','episode:capture','episode:snapshot','episode:read','episode:history'],types:structuredClone(episodeFields)}));
    const permissions={trainer:['partition:reserve','partition:read','feedback:propose','feedback:read','cohort:read','dataset:inspect','recipe:read'],reviewer:['partition:read','feedback:review','feedback:read','cohort:read','dataset:inspect'],owner:['partition:read','feedback:read','cohort:read','dataset:inspect','recipe:read']};
    policy.taskLearning={version:'plus-task-learning-v1',enabled:true,partition:{version:'plus-partition-v1',...input.partition,groupingPolicyHash:taskGroupingPolicyHash},
      groups:input.groups.map(g=>({matterId:g.matterId,workspace:input.workspaceKey,aliases:[]})),
      feedback:[{workspace:input.workspaceKey,policy:{version:'plus-feedback-policy-v1',...input.feedback,classifications:['SYNTHETIC'],variables:[input.targetVariable]}}],cohorts:[],recipes:[],
      grants:Object.entries(principals).map(([name,p])=>({principalId:p.id,requiredRoles:p.roles,workspaces:[input.workspaceKey],permissions:permissions[name],protocolKeys:[],recipeKeys:[],types:{InvestigationTask:{read:['workspaceKey']},Matter:{read:['workspaceKey']}}}))};
    createPrivateTaskServices({storage,tenantId:profile.tenantId,identities,loadPolicy:()=>policy}).assertConfigured();
  }finally{storage.close();}
  if(pins.profile!==fileHash(input.profilePath)||pins.auth!==fileHash(profile.authPath)||pins.policy!==fileHash(profile.policyPath)||digest(inventory)!==digest(inspectNativeDatabase(profile.dbPath)))fail('LEARNING_PLAN_SOURCE_CHANGED');
  const generatedProfile={...profile,policyPath:join(target,'policy.json')};
  const material={request:input,target,pins,inventory,ontologyHash,definitionReference,episodeFields,policy,profile:generatedProfile};
  return {schema:'plus-native-learning-access-plan-v1',planHash:digest(material),material,readOnly:true,dataApprovalGranted:false,trainingStarted:false};
}

export async function applyNativeLearningAccess(plan,expectedHash){
  if(!shape(plan,['schema','planHash','material','readOnly','dataApprovalGranted','trainingStarted'])||plan.schema!=='plus-native-learning-access-plan-v1'||plan.readOnly!==true||plan.dataApprovalGranted!==false||plan.trainingStarted!==false
    ||!hash(expectedHash)||plan.planHash!==expectedHash||digest(plan.material)!==expectedHash)fail('LEARNING_PLAN_HASH_REQUIRED');
  const current=await planNativeLearningAccess(plan.material.request);if(current.planHash!==expectedHash)fail('LEARNING_PLAN_STALE');
  const m=current.material,source=readNativeRuntimeProfile(m.request.profilePath),lock=source.dbPath+'.runtime.lock',lockBytes=bytes({schema:'plus-learning-config-lock-v1',pid:process.pid,nonce:randomUUID()});
  try{writeNew(lock,lockBytes);}catch{fail('LEARNING_PLAN_STOP_RUNTIME_FIRST');}
  try{
    if((await planNativeLearningAccess(m.request)).planHash!==expectedHash)fail('LEARNING_PLAN_STALE');
    mkdirSync(m.target,{mode:0o700});writeNew(join(m.target,'policy.json'),m.policy);writeNew(join(m.target,'runtime.pending'),m.profile);validateNativeRuntimeProfile(m.profile);
    if(m.pins.profile!==fileHash(m.request.profilePath)||m.pins.auth!==fileHash(source.authPath)||m.pins.policy!==fileHash(source.policyPath)||digest(m.inventory)!==digest(inspectNativeDatabase(source.dbPath)))fail('LEARNING_PLAN_SOURCE_CHANGED');
    const receipt={schema:'plus-native-learning-access-installed-v1',planHash:expectedHash,profilePath:join(m.target,'runtime.json'),profileSha256:fileHash(join(m.target,'runtime.pending')),
      policySha256:fileHash(join(m.target,'policy.json')),ontologyHash:m.ontologyHash,definitionReference:m.definitionReference,classification:'SYNTHETIC',
      sourceDatabaseChanged:false,credentialsChanged:false,originalPolicyChanged:false,serviceStarted:false,dataApprovalGranted:false,trainingStarted:false,predictionReady:false};
    writeNew(join(m.target,'installation.json'),receipt);renameSync(join(m.target,'runtime.pending'),receipt.profilePath);sync(m.target);return receipt;
  }finally{
    if(!existsSync(lock)||readFileSync(lock,'utf8')!==lockBytes)fail('LEARNING_PLAN_LOCK_RELEASE_UNCONFIRMED');unlinkSync(lock);
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{const [operation,path,arg]=process.argv.slice(2);if(process.argv.length!==5)fail('LEARNING_PLAN_USAGE');
    if(operation==='plan'){privateParent(dirname(arg));const plan=await planNativeLearningAccess(readBootstrapFile(path));writeNew(arg,plan);process.stdout.write(JSON.stringify({schema:plan.schema,planHash:plan.planHash,readOnly:true,trainingStarted:false})+'\n');}
    else if(operation==='apply')process.stdout.write(JSON.stringify(await applyNativeLearningAccess(readBootstrapFile(path),arg))+'\n');else fail('LEARNING_PLAN_USAGE');
  }catch(e){process.stdout.write(JSON.stringify({schema:'plus-native-learning-access-error-v1',code:/^LEARNING_PLAN_/.test(e?.code??'')?e.code:'LEARNING_PLAN_FAILED',credentialsIncluded:false,serviceStarted:false})+'\n');process.exitCode=2;}
}

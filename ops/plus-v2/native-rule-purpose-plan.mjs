import {readFileSync,lstatSync,realpathSync,existsSync,mkdirSync,openSync,writeSync,fsyncSync,closeSync,unlinkSync,renameSync} from 'node:fs';
import {resolve,isAbsolute,dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {digest} from '../../platform/packages/plus-contracts/dist/index.js';
import {NativeOntologyCatalog,NativeDefinitionRegistry} from '../../platform/packages/plus-runtime/dist/index.js';
import {createNativeStorage} from '../../platform/apps/lwm-demo/src/native-storage.mjs';
import {createPrivateIdentityProvider} from './private-identity.mjs';
import {createPrivateObjectReader} from './object-read-services.mjs';
import {taskRuleSourceFields} from './task-rule-services.mjs';
import {assertInitialLearningConfiguration} from './initial-learning-configuration.mjs';
import {readBootstrapFile} from './native-domain-bootstrap.mjs';
import {readNativeRuntimeProfile,validateNativeRuntimeProfile} from './runtime-host.mjs';
import {inspectNativeDatabase} from './native-backup.mjs';

const fail=code=>{throw Object.assign(Error(code),{code});};
const shape=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const key=v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(v)&&!['__proto__','constructor','prototype'].includes(v);
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const bytes=v=>JSON.stringify(v,null,2)+'\n',fileHash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
function privateParent(path){
  if(process.platform!=='linux'||typeof path!=='string'||!isAbsolute(path)||/[\x00-\x1f\x7f]/.test(path))fail('RULE_PURPOSE_PRIVATE_PARENT_REQUIRED');
  let s;try{s=lstatSync(path);}catch{fail('RULE_PURPOSE_PRIVATE_PARENT_REQUIRED');}
  if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077)!==0||realpathSync(path)!==resolve(path))fail('RULE_PURPOSE_PRIVATE_PARENT_REQUIRED');return resolve(path);
}
function request(raw){
  if(!shape(raw,['schema','profilePath','outputParent','directoryName','definitionKey','expectedDefinitionHash','workspaceKey','specificationKey','purposeId','principals','bindings'])
    ||raw.schema!=='plus-native-rule-purpose-request-v1'||typeof raw.profilePath!=='string'||!isAbsolute(raw.profilePath)
    ||![raw.definitionKey,raw.workspaceKey,raw.specificationKey,raw.purposeId,raw.directoryName].every(key)||!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(raw.directoryName)||!hash(raw.expectedDefinitionHash)
    ||!shape(raw.principals,['trainer','reviewer','owner'])||!Object.values(raw.principals).every(key)||new Set(Object.values(raw.principals)).size!==3
    ||!Array.isArray(raw.bindings)||!raw.bindings.length||raw.bindings.length>32||new Set(raw.bindings.map(b=>b?.moduleKey)).size!==raw.bindings.length
    ||raw.bindings.some(b=>!shape(b,['moduleKey','sourceId','expectedSourceVersion'])||!key(b.moduleKey)||!id(b.sourceId)||!Number.isSafeInteger(b.expectedSourceVersion)||b.expectedSourceVersion<1))fail('RULE_PURPOSE_REQUEST_INVALID');
  return {...structuredClone(raw),outputParent:privateParent(raw.outputParent)};
}
function sync(path){const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
function writeNew(path,value){const fd=openSync(path,'wx',0o600),data=Buffer.from(typeof value==='string'?value:bytes(value));
  try{let n=0;while(n<data.length)n+=writeSync(fd,data,n,data.length-n);fsyncSync(fd);}finally{closeSync(fd);}sync(dirname(path));}

// Initial G1 operator configuration only. All sources must already exist through
// native intake, and all future specifications still need independent review.
// No source insertion, CEL execution, fixture import, token edit or approval.
export async function planNativeRulePurpose(raw){
  const input=request(raw),profile=readNativeRuntimeProfile(input.profilePath),target=join(input.outputParent,input.directoryName);
  // Audit-only startup is still an initial, model-free configuration. Preserve
  // its explicit schedule; never downgrade v2/v3 reviewed model runtimes.
  if(!['plus-runtime-profile-v1','plus-runtime-profile-v4'].includes(profile.schema))fail('RULE_PURPOSE_INITIAL_RUNTIME_REQUIRED');
  if(existsSync(target))fail('RULE_PURPOSE_TARGET_EXISTS');
  const pins={profile:fileHash(input.profilePath),auth:fileHash(profile.authPath),policy:fileHash(profile.policyPath)},inventory=inspectNativeDatabase(profile.dbPath),policy=readBootstrapFile(profile.policyPath);
  if(policy.taskRules!==undefined)fail('RULE_PURPOSE_EXISTING_AUTHORITY_PRESERVED');
  assertInitialLearningConfiguration(policy);
  if(policy.taskDomain.workspaceClassifications?.[input.workspaceKey]!=='SYNTHETIC')fail('RULE_PURPOSE_SYNTHETIC_SCOPE_REQUIRED');
  const identities=createPrivateIdentityProvider({authPath:profile.authPath,tenantId:profile.tenantId}),principals={};identities.assertConfigured();
  for(const [name,role]of [['trainer','trainer'],['reviewer','data_reviewer'],['owner','model_owner']]){
    const p=await identities.resolvePrincipal(input.principals[name]);if(p.tenantId!==profile.tenantId||!p.roles.includes(role))fail('RULE_PURPOSE_ROLE_REQUIRED');principals[name]=p;
  }
  const storage=createNativeStorage(profile.dbPath),ctx={tenantId:profile.tenantId};let definitionReference,ontologyHash,scopeKey;const sourceReferences=[];
  try{
    const entry=Object.hasOwn(policy.definitions,input.definitionKey)?policy.definitions[input.definitionKey]:undefined;
    if(!entry||Object.values(principals).some(p=>!p.roles.some(r=>entry.readRoles.includes(r))))fail('RULE_PURPOSE_DEFINITION_READ_REQUIRED');
    const authorized=p=>Object.values(principals).some(v=>v.id===p.id&&v.tenantId===p.tenantId);
    const catalog=new NativeOntologyCatalog({storage,tenantId:profile.tenantId,authorize:async(p,permission)=>authorized(p)&&permission==='ontology:read'});
    const current=await catalog.read(principals.owner);ontologyHash=current.bundle.contentHash;if(ontologyHash!==profile.expectedOntologyHash)fail('RULE_PURPOSE_ONTOLOGY_MISMATCH');
    if(!current.bundle.parsed.linkTypes.some(l=>l.name==='TaskRuleSpecificationSource'&&l.from==='PlusRuleSpecification'&&l.to==='RuleVersion'&&l.cardinality==='MANY_TO_MANY'))fail('RULE_PURPOSE_SCHEMA_REQUIRED');
    const definitions=new NativeDefinitionRegistry({storage,catalog,tenantId:profile.tenantId,authorize:async(p,permission,k)=>authorized(p)&&permission==='definition:read'&&k===input.definitionKey,policyFor:async()=>entry.policy});
    const published=await definitions.requirePublished(input.definitionKey,principals.owner),compiled=published.compiled;
    if(compiled.definitionHash!==input.expectedDefinitionHash||compiled.definition.rootType!=='InvestigationTask')fail('RULE_PURPOSE_DEFINITION_MISMATCH');
    const modules=compiled.definition.modules.filter(m=>m.kind==='RULE');
    if(!modules.length||digest(modules.map(m=>m.key).sort())!==digest(input.bindings.map(b=>b.moduleKey).sort())||modules.some(m=>m.implementation!=='typed-cel-rule-v1'))fail('RULE_PURPOSE_MODULE_BINDING_REQUIRED');
    scopeKey=compiled.definition.scope.key;definitionReference={id:published.record._id,version:published.record._version,definitionHash:compiled.definitionHash,compiledHash:published.record.compiledHash};
    const reader=createPrivateObjectReader({storage,catalog,tenantId:profile.tenantId,identities,loadPolicy:()=>policy});
    for(const binding of input.bindings){
      // All configured users must already have actual field/scope read grants;
      // operator installation is not an implicit object-browser permission grant.
      for(const p of Object.values(principals)){
        const view=await reader.read('RuleVersion',binding.sourceId,p);
        if([...taskRuleSourceFields,'dataClassification'].some(f=>!Object.hasOwn(view.object,f)))fail('RULE_PURPOSE_SOURCE_FIELDS_REQUIRED');
      }
      const source=await storage.getObject(ctx,'RuleVersion',binding.sourceId);
      if(!source||source._deletedAt||source._tenantId!==profile.tenantId||source._type!=='RuleVersion'||source._version!==binding.expectedSourceVersion
        ||source.workspaceKey!==input.workspaceKey||source.dataClassification!=='SYNTHETIC'||source.lifecycle!=='ACTIVE'||source.deterministic!==true
        ||!Number.isFinite(Date.parse(source.effectiveFrom))||Date.parse(source.effectiveFrom)>Date.now()
        ||taskRuleSourceFields.filter(f=>!['effectiveFrom','deterministic'].includes(f)).some(f=>typeof source[f]!=='string'||!source[f].trim()))fail('RULE_PURPOSE_SOURCE_INVALID');
      sourceReferences.push({moduleKey:binding.moduleKey,id:source._id,version:source._version,hash:digest(source)});
    }
    const common=['rule:read','rule:use'],permissions={trainer:common,reviewer:['rule:draft',...common],owner:['rule:review','rule:revoke',...common]};
    policy.taskRules={version:'plus-private-task-rules-v1',enabled:true,specifications:[{key:input.specificationKey,workspace:input.workspaceKey,policy:{version:'plus-rule-policy-v1',id:input.purposeId,definitionKeys:[input.definitionKey],scopeKeys:[scopeKey],bindings:input.bindings.map(b=>({moduleKey:b.moduleKey,sourceType:'RuleVersion',sourceLink:'TaskRuleSpecificationSource'}))}}],evaluations:[],
      grants:Object.entries(principals).map(([name,p])=>({principalId:p.id,requiredRoles:[{trainer:'trainer',reviewer:'data_reviewer',owner:'model_owner'}[name]],permissions:permissions[name],specificationKeys:[input.specificationKey],evaluationKeys:[],sourceIds:[...new Set(sourceReferences.map(s=>s.id))],sourceFields:[...taskRuleSourceFields]}))};
    assertInitialLearningConfiguration(policy);
  }finally{storage.close();}
  for(const p of Object.values(principals))if(digest(await identities.resolvePrincipal(p.id))!==digest(p))fail('RULE_PURPOSE_IDENTITY_CHANGED');
  if(pins.profile!==fileHash(input.profilePath)||pins.auth!==fileHash(profile.authPath)||pins.policy!==fileHash(profile.policyPath)||digest(inventory)!==digest(inspectNativeDatabase(profile.dbPath)))fail('RULE_PURPOSE_SOURCE_CHANGED');
  const material={request:input,target,pins,inventory,ontologyHash,definitionReference,scopeKey,sourceReferences,policy,profile:{...profile,policyPath:join(target,'policy.json')}};
  return {schema:'plus-native-rule-purpose-plan-v1',planHash:digest(material),material,readOnly:true,nativeApprovalGranted:false,trainingStarted:false};
}
export async function applyNativeRulePurpose(plan,expectedHash){
  if(!shape(plan,['schema','planHash','material','readOnly','nativeApprovalGranted','trainingStarted'])||plan.schema!=='plus-native-rule-purpose-plan-v1'||plan.readOnly!==true||plan.nativeApprovalGranted!==false||plan.trainingStarted!==false
    ||!hash(expectedHash)||plan.planHash!==expectedHash||digest(plan.material)!==expectedHash)fail('RULE_PURPOSE_HASH_REQUIRED');
  const current=await planNativeRulePurpose(plan.material.request);if(current.planHash!==expectedHash)fail('RULE_PURPOSE_STALE');
  const m=current.material,source=readNativeRuntimeProfile(m.request.profilePath),lock=source.dbPath+'.runtime.lock',lockBytes=bytes({schema:'plus-rule-purpose-lock-v1',pid:process.pid,nonce:randomUUID()});
  try{writeNew(lock,lockBytes);}catch{fail('RULE_PURPOSE_STOP_RUNTIME_FIRST');}
  try{
    if((await planNativeRulePurpose(m.request)).planHash!==expectedHash)fail('RULE_PURPOSE_STALE');
    mkdirSync(m.target,{mode:0o700});writeNew(join(m.target,'policy.json'),m.policy);writeNew(join(m.target,'runtime.pending'),m.profile);validateNativeRuntimeProfile(m.profile);
    if(m.pins.profile!==fileHash(m.request.profilePath)||m.pins.auth!==fileHash(source.authPath)||m.pins.policy!==fileHash(source.policyPath)||digest(m.inventory)!==digest(inspectNativeDatabase(source.dbPath)))fail('RULE_PURPOSE_SOURCE_CHANGED');
    const receipt={schema:'plus-native-rule-purpose-installed-v1',planHash:expectedHash,profilePath:join(m.target,'runtime.json'),profileSha256:fileHash(join(m.target,'runtime.pending')),policySha256:fileHash(join(m.target,'policy.json')),
      ontologyHash:m.ontologyHash,definitionReference:m.definitionReference,sourceReferences:m.sourceReferences,specificationKey:m.request.specificationKey,classification:'SYNTHETIC',sourceDatabaseChanged:false,credentialsChanged:false,originalPolicyChanged:false,nativeApprovalGranted:false,trainingStarted:false,serviceStarted:false,predictionReady:false};
    writeNew(join(m.target,'installation.json'),receipt);renameSync(join(m.target,'runtime.pending'),receipt.profilePath);sync(m.target);return receipt;
  }finally{if(!existsSync(lock)||readFileSync(lock,'utf8')!==lockBytes)fail('RULE_PURPOSE_LOCK_RELEASE_UNCONFIRMED');unlinkSync(lock);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{const [operation,path,arg]=process.argv.slice(2);if(process.argv.length!==5)fail('RULE_PURPOSE_USAGE');
    if(operation==='plan'){privateParent(dirname(arg));const plan=await planNativeRulePurpose(readBootstrapFile(path));writeNew(arg,plan);process.stdout.write(JSON.stringify({schema:plan.schema,planHash:plan.planHash,readOnly:true,nativeApprovalGranted:false,trainingStarted:false})+'\n');}
    else if(operation==='apply')process.stdout.write(JSON.stringify(await applyNativeRulePurpose(readBootstrapFile(path),arg))+'\n');else fail('RULE_PURPOSE_USAGE');
  }catch(e){process.stdout.write(JSON.stringify({schema:'plus-native-rule-purpose-error-v1',code:/^RULE_PURPOSE_/.test(e?.code??'')?e.code:'RULE_PURPOSE_FAILED',credentialsIncluded:false,serviceStarted:false})+'\n');process.exitCode=2;}
}

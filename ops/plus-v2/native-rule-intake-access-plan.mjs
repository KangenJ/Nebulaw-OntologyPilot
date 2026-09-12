import {readFileSync,lstatSync,realpathSync,existsSync,mkdirSync,openSync,writeSync,fsyncSync,closeSync,unlinkSync,renameSync} from 'node:fs';
import {isAbsolute,dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {digest} from '../../platform/packages/plus-contracts/dist/index.js';
import {NativeOntologyCatalog} from '../../platform/packages/plus-runtime/dist/index.js';
import {parseActionManifest} from '../../platform/packages/actions/dist/index.js';
import {createNativeStorage} from '../../platform/apps/lwm-demo/src/native-storage.mjs';
import {ruleIntakeManifest,ruleIntakeWrites} from '../../platform/domain-packs/lwm-plus/mechanisms/rule-intake.mjs';
import {readBootstrapFile} from './native-domain-bootstrap.mjs';
import {createPrivateIdentityProvider} from './private-identity.mjs';
import {readNativeRuntimeProfile,validateNativeRuntimeProfile} from './runtime-host.mjs';
import {inspectNativeDatabase} from './native-backup.mjs';
import {assertInitialLearningConfiguration} from './initial-learning-configuration.mjs';
import {taskRuleSourceFields} from './task-rule-services.mjs';

const fail=code=>{throw Object.assign(Error(code),{code});};
const shape=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const key=v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v)&&!['__proto__','constructor','prototype'].includes(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const bytes=v=>JSON.stringify(v,null,2)+'\n',fileHash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
function privateParent(path){
  if(process.platform!=='linux'||typeof path!=='string'||!isAbsolute(path)||/[\x00-\x1f\x7f]/.test(path))fail('RULE_INTAKE_ACCESS_PRIVATE_PARENT_REQUIRED');
  const s=lstatSync(path);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077)!==0||realpathSync(path)!==resolve(path))fail('RULE_INTAKE_ACCESS_PRIVATE_PARENT_REQUIRED');return path;
}
function writeNew(path,value){const fd=openSync(path,'wx',0o600),data=Buffer.from(bytes(value));try{let n=0;while(n<data.length)n+=writeSync(fd,data,n,data.length-n);fsyncSync(fd);}finally{closeSync(fd);}const parent=openSync(dirname(path),'r');try{fsyncSync(parent);}finally{closeSync(parent);}}

// Narrow operator configuration AFTER actual native schema publication. Never
// publishes ontology, imports source content, approves a rule or enables compute.
export async function planNativeRuleIntakeAccess(input){
  const initializeReaders=input?.initializeMissingReaders===true;
  if(!shape(input,['schema','profilePath','outputParent','directoryName','expectedOntologyHash','workspaceKey','sourceSystem','reviewerId','readerIds',...(initializeReaders?['initializeMissingReaders']:[])])
    ||input.schema!=='plus-native-rule-intake-access-request-v1'||![input.directoryName,input.workspaceKey,input.sourceSystem,input.reviewerId].every(key)
    ||!hash(input.expectedOntologyHash)||!Array.isArray(input.readerIds)||!input.readerIds.length||input.readerIds.length>16||!input.readerIds.every(key)
    ||new Set(input.readerIds).size!==input.readerIds.length||!input.readerIds.includes(input.reviewerId))fail('RULE_INTAKE_ACCESS_REQUEST_INVALID');
  input=structuredClone(input);privateParent(input.outputParent);const target=join(input.outputParent,input.directoryName),profile=readNativeRuntimeProfile(input.profilePath);
  if(!['plus-runtime-profile-v1','plus-runtime-profile-v4'].includes(profile.schema))fail('RULE_INTAKE_ACCESS_INITIAL_RUNTIME_REQUIRED');
  if(existsSync(target))fail('RULE_INTAKE_ACCESS_TARGET_EXISTS');
  const pins={profile:fileHash(input.profilePath),auth:fileHash(profile.authPath),policy:fileHash(profile.policyPath)},inventory=inspectNativeDatabase(profile.dbPath),policy=readBootstrapFile(profile.policyPath);
  assertInitialLearningConfiguration(policy);
  if((inventory.objectsByType.PlusModelRelease??0)>0)fail('RULE_INTAKE_ACCESS_MODEL_FREE_REQUIRED');
  if(policy.taskDomain?.workspaceClassifications?.[input.workspaceKey]!=='SYNTHETIC')fail('RULE_INTAKE_ACCESS_SYNTHETIC_SCOPE_REQUIRED');
  if(policy.taskDomain.ruleImportSources?.[input.sourceSystem]!==undefined)fail('RULE_INTAKE_ACCESS_EXISTING_SOURCE_PRESERVED');
  const identities=createPrivateIdentityProvider({authPath:profile.authPath,tenantId:profile.tenantId});identities.assertConfigured();
  const principals=[];for(const id of input.readerIds){const p=await identities.resolvePrincipal(id);if(p.tenantId!==profile.tenantId)fail('RULE_INTAKE_ACCESS_IDENTITY_REQUIRED');principals.push(p);}
  const reviewer=principals.find(p=>p.id===input.reviewerId);if(!reviewer.roles.includes('data_reviewer'))fail('RULE_INTAKE_ACCESS_REVIEWER_REQUIRED');
  // Only existing RuleVersion readers may gain the new classification metadata;
  // sensitive imported record IDs are not silently granted to these readers.
  const readerSlots=new Set(),newReaders=[];
  for(const p of principals){
    const matches=(policy.objectBrowser?.grants??[]).map((g,index)=>({g,index})).filter(({g})=>g.principalId===p.id&&g.objectType==='RuleVersion'&&g.scopeField==='workspaceKey'
      &&g.workspaces.includes(input.workspaceKey)&&g.requiredRoles.every(r=>p.roles.includes(r)));
    if(matches.length===0&&initializeReaders){
      // Explicit opt-in for old installations with NO rule-reader row. Anchor
      // to one existing Matter reader in the same workspace and preserve its
      // role requirements. Never repair ambiguous or incompatible rule grants.
      if((policy.objectBrowser?.grants??[]).some(g=>g.principalId===p.id&&g.objectType==='RuleVersion'&&g.workspaces.includes(input.workspaceKey)))fail('RULE_INTAKE_ACCESS_EXISTING_READER_REQUIRED');
      const anchors=(policy.objectBrowser?.grants??[]).filter(g=>g.principalId===p.id&&g.objectType==='Matter'&&g.scopeField==='workspaceKey'&&g.workspaces.includes(input.workspaceKey)&&g.requiredRoles.every(r=>p.roles.includes(r)));
      if(anchors.length!==1)fail('RULE_INTAKE_ACCESS_EXISTING_READER_REQUIRED');
      newReaders.push({principalId:p.id,requiredRoles:[...anchors[0].requiredRoles],objectType:'RuleVersion',scopeField:'workspaceKey',workspaces:[input.workspaceKey],fields:[...taskRuleSourceFields,'dataClassification']});
    }else{if(matches.length!==1)fail('RULE_INTAKE_ACCESS_EXISTING_READER_REQUIRED');readerSlots.add(matches[0].index);}
  }
  const storage=createNativeStorage(profile.dbPath);let current;
  try{current=await new NativeOntologyCatalog({storage,tenantId:profile.tenantId,authorize:async(p,permission)=>p.id===reviewer.id&&permission==='ontology:read'}).read(reviewer);}finally{storage.close();}
  if(current.bundle.contentHash!==input.expectedOntologyHash||profile.expectedOntologyHash!==input.expectedOntologyHash)fail('RULE_INTAKE_ACCESS_ONTOLOGY_MISMATCH');
  const expected=parseActionManifest(JSON.stringify(ruleIntakeManifest()));
  const type=current.bundle.parsed.objectTypes.find(t=>t.name==='RuleVersion');
  if(!expected.valid||current.bundle.disabledActions.includes('NativeImportTaskRule')||digest(current.bundle.manifests.NativeImportTaskRule??null)!==digest(expected.manifest)
    ||ruleIntakeWrites.some(name=>!type?.fields.some(f=>f.name===name&&!f.directives.some(d=>['primary','computed','link'].includes(d.kind)))))fail('RULE_INTAKE_ACCESS_PUBLISHED_CONTRACT_REQUIRED');
  const original=structuredClone(policy);
  policy.taskDomain.ruleImportSources={...(policy.taskDomain.ruleImportSources??{}),[input.sourceSystem]:{workspaceKey:input.workspaceKey,classification:'SYNTHETIC',deterministic:true,allowedRoles:['data_reviewer']}};
  policy.taskDomain.grants=[...policy.taskDomain.grants,{principalId:reviewer.id,actions:['NativeImportTaskRule'],workspaces:[input.workspaceKey],types:{RuleVersion:{read:[],write:[...ruleIntakeWrites],create:true}}}];
  // The reader deliberately rejects overlapping grants. Split only the target
  // workspace out of its one existing row, preserving roles and all other
  // scopes/fields. Never union ambiguous grants or widen a foreign workspace.
  policy.objectBrowser.grants=policy.objectBrowser.grants.flatMap((g,index)=>{
    if(!readerSlots.has(index))return [g];
    const others=g.workspaces.filter(w=>w!==input.workspaceKey);
    return [...(others.length?[{...g,workspaces:others}]:[]),{...g,workspaces:[input.workspaceKey],fields:[...new Set([...g.fields,'dataClassification'])]}];
  });
  policy.objectBrowser.grants.push(...newReaders);
  assertInitialLearningConfiguration(policy);
  for(const p of principals)if(digest(await identities.resolvePrincipal(p.id))!==digest(p))fail('RULE_INTAKE_ACCESS_IDENTITY_CHANGED');
  if(pins.profile!==fileHash(input.profilePath)||pins.auth!==fileHash(profile.authPath)||pins.policy!==fileHash(profile.policyPath)||digest(inventory)!==digest(inspectNativeDatabase(profile.dbPath)))fail('RULE_INTAKE_ACCESS_SOURCE_CHANGED');
  const material={request:input,target,pins,inventory,originalPolicyHash:digest(original),policy,profile:{...profile,policyPath:join(target,'policy.json')}};
  return {schema:'plus-native-rule-intake-access-plan-v1',planHash:digest(material),material,readOnly:true,nativeApprovalGranted:false,serviceStarted:false};
}

export async function applyNativeRuleIntakeAccess(plan,expectedHash){
  if(!shape(plan,['schema','planHash','material','readOnly','nativeApprovalGranted','serviceStarted'])||plan.schema!=='plus-native-rule-intake-access-plan-v1'||plan.readOnly!==true
    ||plan.nativeApprovalGranted!==false||plan.serviceStarted!==false||!hash(expectedHash)||plan.planHash!==expectedHash||digest(plan.material)!==expectedHash)fail('RULE_INTAKE_ACCESS_HASH_REQUIRED');
  const current=await planNativeRuleIntakeAccess(plan.material.request);if(current.planHash!==expectedHash)fail('RULE_INTAKE_ACCESS_STALE');
  const m=current.material,lock=m.profile.dbPath+'.runtime.lock',lockValue={schema:'plus-rule-intake-config-lock-v1',pid:process.pid,nonce:randomUUID()};
  try{writeNew(lock,lockValue);}catch{fail('RULE_INTAKE_ACCESS_STOP_RUNTIME_FIRST');}
  try{
    if((await planNativeRuleIntakeAccess(m.request)).planHash!==expectedHash)fail('RULE_INTAKE_ACCESS_STALE');
    mkdirSync(m.target,{mode:0o700});writeNew(join(m.target,'policy.json'),m.policy);writeNew(join(m.target,'runtime.pending'),m.profile);validateNativeRuntimeProfile(m.profile);
    const source=readNativeRuntimeProfile(m.request.profilePath);
    if(m.pins.profile!==fileHash(m.request.profilePath)||m.pins.auth!==fileHash(source.authPath)||m.pins.policy!==fileHash(source.policyPath)
      ||digest(m.inventory)!==digest(inspectNativeDatabase(source.dbPath)))fail('RULE_INTAKE_ACCESS_SOURCE_CHANGED');
    const receipt={schema:'plus-native-rule-intake-access-installed-v1',planHash:expectedHash,profilePath:join(m.target,'runtime.json'),profileSha256:fileHash(join(m.target,'runtime.pending')),
      policySha256:fileHash(join(m.target,'policy.json')),ontologyHash:m.profile.expectedOntologyHash,sourceSystem:m.request.sourceSystem,classification:'SYNTHETIC',
      originalDatabaseChanged:false,credentialsChanged:false,originalPolicyChanged:false,nativeApprovalGranted:false,serviceStarted:false,predictionReady:false};
    writeNew(join(m.target,'installation.json'),receipt);renameSync(join(m.target,'runtime.pending'),receipt.profilePath);
    const fd=openSync(m.target,'r');try{fsyncSync(fd);}finally{closeSync(fd);}return receipt;
  }finally{if(!existsSync(lock)||readFileSync(lock,'utf8')!==bytes(lockValue))fail('RULE_INTAKE_ACCESS_LOCK_RELEASE_UNCONFIRMED');unlinkSync(lock);}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{const[op,path,arg]=process.argv.slice(2);if(process.argv.length!==5)fail('RULE_INTAKE_ACCESS_USAGE');
    if(op==='plan'){privateParent(dirname(arg));const plan=await planNativeRuleIntakeAccess(readBootstrapFile(path));writeNew(arg,plan);console.log(JSON.stringify({schema:plan.schema,planHash:plan.planHash,readOnly:true,nativeApprovalGranted:false}));}
    else if(op==='apply')console.log(JSON.stringify(await applyNativeRuleIntakeAccess(readBootstrapFile(path),arg)));else fail('RULE_INTAKE_ACCESS_USAGE');
  }catch(e){console.log(JSON.stringify({schema:'plus-native-rule-intake-access-error-v1',code:/^RULE_INTAKE_ACCESS_/.test(e?.code??'')?e.code:'RULE_INTAKE_ACCESS_FAILED',credentialsIncluded:false,serviceStarted:false}));process.exitCode=2;}
}

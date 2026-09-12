// Explicit Linux operator bootstrap for G1 machine identities. Identity is not
// data, FIT, approval or deployment authority. No mutation of the source auth.
import {constants,readFileSync,lstatSync,realpathSync,existsSync,mkdirSync,openSync,writeFileSync,fsyncSync,closeSync,unlinkSync,renameSync} from 'node:fs';
import {resolve,isAbsolute,dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {digest} from '../../platform/packages/plus-contracts/dist/index.js';
import {NativeOntologyCatalog} from '../../platform/packages/plus-runtime/dist/index.js';
import {createNativeStorage} from '../../platform/apps/lwm-demo/src/native-storage.mjs';
import {readNativeRuntimeProfile,validateNativeRuntimeProfile} from './runtime-host.mjs';
import {assertInitialLearningConfiguration} from './initial-learning-configuration.mjs';
import {createPrivateIdentityProvider} from './private-identity.mjs';
import {inspectNativeDatabase} from './native-backup.mjs';

const fail=code=>{throw Object.assign(Error(code),{code});};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const key=v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(v)&&!['__proto__','constructor','prototype'].includes(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const sha=b=>createHash('sha256').update(b).digest('hex'),fileHash=p=>sha(readFileSync(p));
const bytes=v=>JSON.stringify(v,null,2)+'\n';
const roleFor={FIT:'plus_compute_worker',GOVERNANCE:'plus_governance_worker'};
function secure(path,directory=false){
  if(process.platform!=='linux'||typeof path!=='string'||!isAbsolute(path)||resolve(path)!==path||/[\x00-\x1f\x7f]/.test(path))fail('WORKER_IDENTITY_PRIVATE_PATH_REQUIRED');
  let stat;try{stat=lstatSync(path);}catch{fail('WORKER_IDENTITY_PRIVATE_PATH_REQUIRED');}
  if(stat.isSymbolicLink()||realpathSync(path)!==path||(directory?!stat.isDirectory():!stat.isFile())||stat.uid!==process.getuid()||(stat.mode&0o077)!==0||!directory&&stat.nlink!==1)fail('WORKER_IDENTITY_PRIVATE_PATH_REQUIRED');
  return path;
}
function request(raw){
  if(!exact(raw,['schema','profilePath','outputParent','directoryName','expiresAt','workers'])||raw.schema!=='plus-native-worker-identity-request-v1'
    ||typeof raw.profilePath!=='string'||!isAbsolute(raw.profilePath)||!key(raw.directoryName)||!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(raw.directoryName)
    ||typeof raw.expiresAt!=='string'||!Number.isFinite(Date.parse(raw.expiresAt))||new Date(raw.expiresAt).toISOString()!==raw.expiresAt
    ||!Array.isArray(raw.workers)||raw.workers.length<1||raw.workers.length>8||new Set(raw.workers.map(w=>w?.id)).size!==raw.workers.length
    ||raw.workers.some(w=>!exact(w,['id','kind'])||!key(w.id)||!Object.hasOwn(roleFor,w.kind)))fail('WORKER_IDENTITY_REQUEST_INVALID');
  const remaining=Date.parse(raw.expiresAt)-Date.now();if(remaining<60000||remaining>86400000)fail('WORKER_IDENTITY_EXPIRY_OUT_OF_RANGE');
  secure(raw.profilePath);secure(raw.outputParent,true);return structuredClone(raw);
}
function syncDirectory(path){const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY);try{fsyncSync(fd);}finally{closeSync(fd);}}
function writeNew(path,value){const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{writeFileSync(fd,typeof value==='string'?value:bytes(value));fsyncSync(fd);}finally{closeSync(fd);}syncDirectory(dirname(path));}

export async function planNativeWorkerIdentities(raw){
  const input=request(raw),profile=readNativeRuntimeProfile(input.profilePath),target=join(input.outputParent,input.directoryName);
  if(!['plus-runtime-profile-v1','plus-runtime-profile-v4'].includes(profile.schema))fail('WORKER_IDENTITY_INITIAL_RUNTIME_REQUIRED');
  if(existsSync(target))fail('WORKER_IDENTITY_TARGET_EXISTS');
  secure(profile.authPath);secure(dirname(profile.authPath),true);secure(profile.policyPath);
  const pins={profile:fileHash(input.profilePath),auth:fileHash(profile.authPath),policy:fileHash(profile.policyPath)},inventory=inspectNativeDatabase(profile.dbPath);
  const policy=JSON.parse(readFileSync(profile.policyPath));assertInitialLearningConfiguration(policy);
  if(!Object.values(policy.taskDomain.workspaceClassifications??{}).length||Object.values(policy.taskDomain.workspaceClassifications).some(v=>v!=='SYNTHETIC')||inventory.objectsByType.PlusModelRelease)fail('WORKER_IDENTITY_INITIAL_SYNTHETIC_ONLY');
  const identities=createPrivateIdentityProvider({authPath:profile.authPath,tenantId:profile.tenantId});identities.assertConfigured();
  const originalRows=JSON.parse(readFileSync(profile.authPath));
  if(originalRows.length+input.workers.length>1000)fail('WORKER_IDENTITY_ACCOUNT_LIMIT');
  // Also forbid disabled/expired historical IDs. Never resurrect an identity or
  // infer a worker's privileges from a person's old token or another tenant.
  if(input.workers.some(w=>originalRows.some(r=>r.id===w.id)))fail('WORKER_IDENTITY_EXISTING_PRINCIPAL');
  const storage=createNativeStorage(profile.dbPath);let ontologyHash;
  try{const operator={id:'plus-worker-install-integrity-reader',tenantId:profile.tenantId,roles:[]};
    const catalog=new NativeOntologyCatalog({storage,tenantId:profile.tenantId,authorize:async(p,permission)=>p.id===operator.id&&permission==='ontology:read'});
    ontologyHash=(await catalog.read(operator)).bundle.contentHash;if(ontologyHash!==profile.expectedOntologyHash)fail('WORKER_IDENTITY_ONTOLOGY_MISMATCH');
  }finally{storage.close();}
  const principals=input.workers.map(w=>({id:w.id,tenantId:profile.tenantId,roles:[roleFor[w.kind]],expiresAt:input.expiresAt}));
  request(input);if(pins.profile!==fileHash(input.profilePath)||pins.auth!==fileHash(profile.authPath)||pins.policy!==fileHash(profile.policyPath)||digest(inventory)!==digest(inspectNativeDatabase(profile.dbPath)))fail('WORKER_IDENTITY_SOURCE_CHANGED');
  const material={request:input,target,pins,inventory,ontologyHash,principals,originalRecordCount:originalRows.length,profile:{...profile,authPath:join(target,'auth.json')}};
  return {schema:'plus-native-worker-identity-plan-v1',planHash:digest(material),material,readOnly:true,authorityGranted:false,serviceStarted:false,credentialsIncluded:false};
}

export async function applyNativeWorkerIdentities(plan,expectedHash){
  if(!exact(plan,['schema','planHash','material','readOnly','authorityGranted','serviceStarted','credentialsIncluded'])||plan.schema!=='plus-native-worker-identity-plan-v1'
    ||plan.readOnly!==true||plan.authorityGranted!==false||plan.serviceStarted!==false||plan.credentialsIncluded!==false||!hash(expectedHash)||plan.planHash!==expectedHash||digest(plan.material)!==expectedHash)fail('WORKER_IDENTITY_HASH_REQUIRED');
  const current=await planNativeWorkerIdentities(plan.material.request);if(current.planHash!==expectedHash)fail('WORKER_IDENTITY_STALE');
  const m=current.material,source=readNativeRuntimeProfile(m.request.profilePath),lock=source.dbPath+'.runtime.lock',lockBytes=bytes({schema:'plus-worker-identity-lock-v1',pid:process.pid,nonce:randomUUID()});
  try{writeNew(lock,lockBytes);}catch{fail('WORKER_IDENTITY_STOP_RUNTIME_FIRST');}
  try{
    if((await planNativeWorkerIdentities(m.request)).planHash!==expectedHash)fail('WORKER_IDENTITY_STALE');
    mkdirSync(m.target,{mode:0o700});syncDirectory(dirname(m.target));
    const rows=JSON.parse(readFileSync(source.authPath)),credentials=[];
    for(const principal of m.principals){const token=randomBytes(48).toString('base64url'),path=join(m.target,principal.id+'.credential.json');
      rows.push({...principal,tokenHash:sha(token)});
      writeNew(path,{schema:'plus-private-service-credential-v1',...principal,token,warning:'Private G1 service identity. No data, FIT, approval or deployment grant. Do not copy into chat, logs, Git or personal access directories.'});
      credentials.push({...principal,path});
    }
    writeNew(m.profile.authPath,rows);createPrivateIdentityProvider({authPath:m.profile.authPath,tenantId:source.tenantId}).assertConfigured();
    writeNew(join(m.target,'runtime.pending'),m.profile);validateNativeRuntimeProfile(m.profile);
    request(m.request);if(m.pins.profile!==fileHash(m.request.profilePath)||m.pins.auth!==fileHash(source.authPath)||m.pins.policy!==fileHash(source.policyPath)||digest(m.inventory)!==digest(inspectNativeDatabase(source.dbPath)))fail('WORKER_IDENTITY_SOURCE_CHANGED');
    const receipt={schema:'plus-native-worker-identity-installed-v1',planHash:expectedHash,profilePath:join(m.target,'runtime.json'),profileSha256:fileHash(join(m.target,'runtime.pending')),authSha256:fileHash(m.profile.authPath),credentials,
      originalAuthUnchanged:true,originalPolicyUnchanged:true,originalProfileUnchanged:true,sourceDatabaseChanged:false,classification:'SYNTHETIC_G1',authorityGranted:false,trainingStarted:false,serviceStarted:false,credentialsIncluded:false};
    writeNew(join(m.target,'installation.json'),receipt);renameSync(join(m.target,'runtime.pending'),receipt.profilePath);syncDirectory(m.target);return receipt;
  }finally{if(!existsSync(lock)||readFileSync(lock,'utf8')!==lockBytes)fail('WORKER_IDENTITY_LOCK_RELEASE_UNCONFIRMED');unlinkSync(lock);syncDirectory(dirname(lock));}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{const [operation,path,arg]=process.argv.slice(2);if(process.argv.length!==5)fail('WORKER_IDENTITY_USAGE');
    if(operation==='plan'){secure(dirname(arg),true);const plan=await planNativeWorkerIdentities(JSON.parse(readFileSync(secure(path))));writeNew(arg,plan);console.log(JSON.stringify({schema:plan.schema,planHash:plan.planHash,readOnly:true,authorityGranted:false,credentialsIncluded:false}));}
    else if(operation==='apply')console.log(JSON.stringify(await applyNativeWorkerIdentities(JSON.parse(readFileSync(secure(path))),arg)));else fail('WORKER_IDENTITY_USAGE');
  }catch(e){console.log(JSON.stringify({schema:'plus-worker-identity-error-v1',code:/^WORKER_IDENTITY_/.test(e?.code??'')?e.code:'WORKER_IDENTITY_FAILED',credentialsIncluded:false,serviceStarted:false}));process.exitCode=2;}
}

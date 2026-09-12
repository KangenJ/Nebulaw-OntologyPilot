import {readFileSync,openSync,closeSync,fstatSync,readSync,writeSync,fsyncSync,lstatSync,realpathSync,mkdirSync,constants} from 'node:fs';
import {resolve,join,dirname,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash,randomBytes} from 'node:crypto';
import {digest} from '../../platform/packages/plus-contracts/dist/index.js';
import {loadDomainPacks} from '../../platform/packages/api/dist/schema-loader.js';
import {NativeOntologyCatalog,buildOntologyBundle,ontologyStorageSchema} from '../../platform/packages/plus-runtime/dist/index.js';
import {createNativeStorage} from '../../platform/apps/lwm-demo/src/native-storage.mjs';
import {buildTaskVerificationInput} from '../../platform/domain-packs/lwm-plus/mechanisms/task-verification.mjs';
import {buildTaskPriorityInput} from '../../platform/domain-packs/lwm-plus/mechanisms/task-priority.mjs';
import {buildTaskRulesInput,taskInvestigationMechanismDefinition} from '../../platform/domain-packs/lwm-plus/mechanisms/task-rules.mjs';
import {buildTaskSourceGovernanceInput} from '../../platform/domain-packs/lwm-plus/mechanisms/task-source-governance.mjs';
import {buildMatterIntakeInput,matterIntakeWrites} from '../../platform/domain-packs/lwm-plus/mechanisms/matter-intake.mjs';
import {buildRuleIntakeInput,ruleIntakeWrites} from '../../platform/domain-packs/lwm-plus/mechanisms/rule-intake.mjs';
import {inspectNativeDatabase} from './native-backup.mjs';
import {validateNativeRuntimeProfile} from './runtime-host.mjs';

const fail=code=>{throw Object.assign(Error(code),{code});};
const shape=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const key=v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v)&&!['__proto__','constructor','prototype'].includes(v);
const roles=['viewer','investigator','data_reviewer','trainer','model_owner','case_reviewer'];
const fields={
  RuleVersion:[...ruleIntakeWrites],
  Matter:[...matterIntakeWrites],
  InvestigationTask:['workspaceKey','taskNumber','title','status','priority','assignee','instructions','dueAt','createdAt','receivedAt','registeredBy','actualCompletion','actualCompletionAt','actualCompletionRecordedAt','dataClassification','priorityEffectiveAt','priorityRecordedAt'],
  Observation:['workspaceKey','observationNumber','title','kind','source','summary','confidence','verified','recordedBy','observedAt','receivedAt','reportedCompletion','channelKey','sourceSystem','sourceRecordId','sourceRevision','sourceEventKey','sourceContentHash','dataClassification'],
};
function linux(){if(process.platform!=='linux')fail('BOOTSTRAP_LINUX_REQUIRED');}
function privateDirectory(path){
  linux();if(typeof path!=='string'||!isAbsolute(path)||/[\x00-\x1f\x7f]/.test(path))fail('BOOTSTRAP_PRIVATE_PARENT_REQUIRED');
  let s,canonical;try{s=lstatSync(path);canonical=realpathSync(path);}catch{fail('BOOTSTRAP_PRIVATE_PARENT_REQUIRED');}
  if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077)!==0||canonical!==resolve(path))fail('BOOTSTRAP_PRIVATE_PARENT_REQUIRED');
  return canonical;
}
function syncDirectory(path){const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
function writeNew(path,value){
  const bytes=Buffer.from(typeof value==='string'?value:JSON.stringify(value,null,2)+'\n'),fd=openSync(path,'wx',0o600);
  try{let offset=0;while(offset<bytes.length)offset+=writeSync(fd,bytes,offset,bytes.length-offset);fsyncSync(fd);}finally{closeSync(fd);}
  syncDirectory(dirname(path));
}
export function readBootstrapFile(path,max=2_097_152){
  linux();if(typeof path!=='string'||!isAbsolute(path))fail('BOOTSTRAP_PRIVATE_FILE_REQUIRED');
  let fd;
  try{
    privateDirectory(dirname(path));fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);const s=fstatSync(fd);
    if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid()||(s.mode&0o077)!==0||s.size<1||s.size>max)fail('BOOTSTRAP_PRIVATE_FILE_REQUIRED');
    const bytes=Buffer.alloc(s.size+1);let n=0,count;do{count=readSync(fd,bytes,n,bytes.length-n,null);n+=count;}while(count&&n<bytes.length);
    if(n!==s.size)fail('BOOTSTRAP_FILE_CHANGED');return JSON.parse(bytes.subarray(0,n).toString('utf8'));
  }catch(e){if(e.code?.startsWith('BOOTSTRAP_'))throw e;fail('BOOTSTRAP_PRIVATE_FILE_REQUIRED');}finally{if(fd!==undefined)closeSync(fd);}
}
function request(raw){
  if(!shape(raw,['schema','parentDir','directoryName','tenantId','workspaceKey','ports','credentialHours'])||raw.schema!=='plus-domain-bootstrap-request-v1'
    ||![raw.directoryName,raw.tenantId,raw.workspaceKey].every(key)||!Number.isInteger(raw.credentialHours)||raw.credentialHours<1||raw.credentialHours>24
    ||!shape(raw.ports,['control','workbench','cel'])||Object.values(raw.ports).some(p=>!Number.isInteger(p)||p<0||p>65535))fail('BOOTSTRAP_REQUEST_INVALID');
  const selected=Object.values(raw.ports).filter(p=>p!==0);if(new Set(selected).size!==selected.length)fail('BOOTSTRAP_REQUEST_INVALID');
  return {...structuredClone(raw),parentDir:privateDirectory(raw.parentDir)};
}
function policyFor(config,bundle){
  const workspace=config.workspaceKey,principals=roles.map(role=>({id:'demo-'+role,tenantId:config.tenantId,roles:[role]}));
  for(const [type,names]of Object.entries(fields))for(const name of names){
    const f=bundle.parsed.objectTypes.find(t=>t.name===type)?.fields.find(f=>f.name===name);
    if(!f||f.directives.some(d=>['link','computed','primary'].includes(d.kind)))fail('BOOTSTRAP_FIELD_CONTRACT_CHANGED');
  }
  const rw=(read=[],write=[],create=false)=>({read,write,...(create?{create:true}:{})});
  const taskRead=['workspaceKey','dataClassification','actualCompletion','actualCompletionAt','actualCompletionRecordedAt'];
  const grants=[
    {principalId:'demo-data_reviewer',actions:['NativeImportTaskRule'],workspaces:[workspace],types:{RuleVersion:rw([],ruleIntakeWrites,true)}},
    {principalId:'demo-investigator',actions:['NativeImportTaskMatter'],workspaces:[workspace],types:{Matter:rw([],matterIntakeWrites,true)}},
    {principalId:'demo-investigator',actions:['NativeRegisterInvestigationTask'],workspaces:[workspace],types:{Matter:rw(['workspaceKey']),InvestigationTask:rw([],fields.InvestigationTask.filter(f=>!['actualCompletionAt','actualCompletionRecordedAt'].includes(f)),true)}},
    {principalId:'demo-investigator',actions:['NativeRecordTaskObservation'],workspaces:[workspace],types:{InvestigationTask:rw(taskRead),Observation:rw([],fields.Observation,true)}},
    {principalId:'demo-data_reviewer',actions:['NativeVerifyTaskObservation'],workspaces:[workspace],types:{InvestigationTask:rw(taskRead,['actualCompletion','actualCompletionAt','actualCompletionRecordedAt']),Observation:rw(['workspaceKey','recordedBy','observedAt','dataClassification','reportedCompletion']),TaskCompletionVerification:rw([],['verificationKey','taskVersion','observationVersion','result','targetTime','recordedAt','recordedBy','methodKey','mode','evidence','classification'],true)}},
  ];
  const mechanism=taskInvestigationMechanismDefinition();
  return {principals,definitionCandidate:mechanism.definition,policy:{version:1,definitions:{[mechanism.definition.key]:{readRoles:roles,draftRoles:['data_reviewer'],publishRoles:['model_owner'],policy:mechanism.policy,candidate:mechanism.definition}},
    taskDomain:{enabled:true,workspaceClassifications:{[workspace]:'SYNTHETIC'},ruleImportSources:{'demo-rule':{workspaceKey:workspace,classification:'SYNTHETIC',deterministic:true,allowedRoles:['data_reviewer']}},matterImportSources:{'demo-matter':{workspaceKey:workspace,classification:'SYNTHETIC',allowedRoles:['investigator']}},sources:{'demo-report':{classification:'SYNTHETIC',channelKeys:['report'],allowedRoles:['investigator']}},
      verificationMethods:{independent:{policyRef:'independent-task-check-v1',mode:'GOLD',allowedRoles:['data_reviewer'],classifications:['SYNTHETIC']}},grants},
    objectBrowser:{version:'plus-private-object-browser-v1',enabled:true,
      grants:principals.flatMap(p=>Object.entries(fields).map(([objectType,names])=>({principalId:p.id,requiredRoles:p.roles,objectType,scopeField:'workspaceKey',workspaces:[workspace],fields:names}))),
      linkGrants:principals.flatMap(p=>['MatterTask','TaskObservation'].map(linkType=>({principalId:p.id,requiredRoles:p.roles,linkType,directions:['inbound','outbound'],
        from:{scopeField:'workspaceKey',workspaces:[workspace]},to:{scopeField:'workspaceKey',workspaces:[workspace]},fields:[]})))},
  }};
}

// Only checked-in production definitions. Explicit empty extraDirs defeats
// ambient DOMAIN_PACKS_* extension. No seed manifests or test fixtures executed.
export async function planNativeDomain(raw){
  linux();const config=request(raw),packsDir=fileURLToPath(new URL('../../platform/domain-packs',import.meta.url));
  const loaded=await loadDomainPacks(packsDir,['core','lwm-demo','lwm-plus','plus-core'],[]);
  const odl=loaded.packInfos.flatMap(p=>p.manifest.schema.map(path=>readFileSync(join(p.packDir,path),'utf8'))).join('\n');
  let baseline=buildTaskVerificationInput({odl,manifests:{},disabledActions:loaded.parsed.actionTypes.map(a=>a.name)});
  baseline=buildTaskSourceGovernanceInput(buildTaskRulesInput(buildTaskPriorityInput(baseline,{initializePriority:true})));
  baseline=buildMatterIntakeInput(baseline);
  baseline=buildRuleIntakeInput(baseline);
  const bundle=buildOntologyBundle(baseline),{principals,definitionCandidate,policy}=policyFor(config,bundle);
  const material={schema:'plus-domain-bootstrap-material-v1',request:config,targetDir:join(config.parentDir,config.directoryName),baseline,ontologyHash:bundle.contentHash,
    principals,policy,definitionCandidate,capabilities:{businessData:'EMPTY',classification:'SYNTHETIC',definitionPublished:false,predictionReady:false,backgroundWorkers:'DISABLED',fullModelQualification:'NOT_GRANTED'},
    inventory:{objects:bundle.parsed.objectTypes.map(t=>t.name),links:bundle.parsed.linkTypes.map(t=>t.name),actions:bundle.parsed.actionTypes.map(t=>t.name),disabledActions:baseline.disabledActions}};
  return {schema:'plus-domain-bootstrap-plan-v1',planHash:digest(material),material};
}
export async function writeNativeDomainPlan(raw,planPath){
  if(typeof planPath!=='string'||!isAbsolute(planPath))fail('BOOTSTRAP_PRIVATE_FILE_REQUIRED');privateDirectory(dirname(planPath));
  const plan=await planNativeDomain(raw);writeNew(planPath,plan);return {schema:plan.schema,planHash:plan.planHash,planPath,targetDir:plan.material.targetDir,applied:false};
}
export async function applyNativeDomainPlan(raw,expectedHash){
  linux();if(!shape(raw,['schema','planHash','material'])||raw.schema!=='plus-domain-bootstrap-plan-v1'||typeof expectedHash!=='string'||!/^[a-f0-9]{64}$/.test(expectedHash)
    ||raw.planHash!==expectedHash||digest(raw.material)!==expectedHash)fail('BOOTSTRAP_PLAN_HASH_MISMATCH');
  const current=await planNativeDomain(raw.material.request);if(current.planHash!==expectedHash)fail('BOOTSTRAP_PLAN_STALE');
  const {targetDir,request:config,baseline,ontologyHash,principals,policy,definitionCandidate}=current.material;
  // mkdir is exclusive. Never claim/reuse a partial or existing directory.
  try{mkdirSync(targetDir,{mode:0o700});syncDirectory(config.parentDir);}catch{fail('BOOTSTRAP_TARGET_EXISTS_OR_UNWRITABLE');}
  let storage;
  try{
    writeNew(join(targetDir,'installation-started.json'),{schema:'plus-domain-installation-start-v1',planHash:expectedHash,startedAt:new Date().toISOString()});
    const dbPath=join(targetDir,'platform.sqlite'),authPath=join(targetDir,'auth.json'),policyPath=join(targetDir,'policy.json'),profilePath=join(targetDir,'runtime.json');
    writeNew(dbPath,'');storage=createNativeStorage(dbPath);const bundle=buildOntologyBundle(baseline),ctx={tenantId:config.tenantId};
    await storage.applySchema(ctx,ontologyStorageSchema(bundle,1));
    const installer={id:'bootstrap-'+expectedHash.slice(0,24),tenantId:config.tenantId,roles:[]};
    const catalog=new NativeOntologyCatalog({storage,tenantId:config.tenantId,authorize:async(p,permission)=>p.id===installer.id&&p.tenantId===installer.tenantId&&['ontology:adopt','ontology:read'].includes(permission)});
    await catalog.adoptInstalledBaseline(baseline,installer);const installed=await catalog.read(installer);
    if(installed.bundle.contentHash!==ontologyHash)fail('BOOTSTRAP_INSTALLED_HASH_MISMATCH');storage.close();storage=undefined;
    const inventory=inspectNativeDatabase(dbPath),expiresAt=new Date(Date.now()+config.credentialHours*3600000).toISOString(),records=[];
    const accessDir=join(targetDir,'access');mkdirSync(accessDir,{mode:0o700});syncDirectory(targetDir);
    for(const p of principals){const token=randomBytes(32).toString('hex');records.push({...p,tokenHash:createHash('sha256').update(token).digest('hex'),expiresAt});writeNew(join(accessDir,p.id+'.json'),{schema:'plus-private-personal-credential-v1',...p,token,expiresAt});}
    writeNew(authPath,records);writeNew(policyPath,policy);writeNew(join(targetDir,'definition-candidate.json'),definitionCandidate);
    writeNew(join(targetDir,'reviewed-plan.json'),current);
    const profile=validateNativeRuntimeProfile({schema:'plus-runtime-profile-v1',tenantId:config.tenantId,dbPath,authPath,policyPath,ports:config.ports,expectedOntologyHash:ontologyHash});
    const receipt={schema:'plus-domain-installation-v1',status:'INSTALLED_NOT_STARTED',planHash:expectedHash,targetDir,profilePath,ontologyHash,installedAt:new Date().toISOString(),expiresAt,
      personalAccessFiles:principals.map(p=>({id:p.id,roles:p.roles,path:join(accessDir,p.id+'.json')})),inventory,
      businessData:'EMPTY',definitionPublished:false,predictionReady:false,backgroundWorkers:'DISABLED',fullModelQualification:'NOT_GRANTED',independentHumanReviewProven:false};
    writeNew(join(targetDir,'installation-complete.json'),receipt);
    // Operational entry point appears last, after every required artifact.
    writeNew(profilePath,profile);return receipt;
  }catch(error){try{storage?.close();}catch{}throw Object.assign(Error('BOOTSTRAP_APPLY_FAILED'),{code:'BOOTSTRAP_APPLY_FAILED',targetDir,cause:error});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    const [command,path,argument,...extra]=process.argv.slice(2);if(extra.length||!path||!argument)fail('BOOTSTRAP_USAGE');
    const result=command==='plan'?await writeNativeDomainPlan(readBootstrapFile(path,16384),argument):command==='apply'?await applyNativeDomainPlan(readBootstrapFile(path),argument):fail('BOOTSTRAP_USAGE');
    process.stdout.write(JSON.stringify(result)+'\n');
  }catch(e){process.stdout.write(JSON.stringify({schema:'plus-domain-bootstrap-error-v1',code:e.code?.startsWith('BOOTSTRAP_')?e.code:'BOOTSTRAP_FAILED',...(e.targetDir?{incompleteDirectory:e.targetDir}:{}),servicesStarted:false})+'\n');process.exitCode=2;}
}

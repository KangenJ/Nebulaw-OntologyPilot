import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NativeOntologyCatalog,buildOntologyBundle,ontologyStorageSchema,createActionOutboxJournal} from '../dist/index.js';
import {createNativeStorage} from '../../../apps/lwm-demo/src/native-storage.mjs';
import {startPlusControlServer} from '../../../../ops/plus-v2/control-server.mjs';
import {createPrivateIdentityProvider} from '../../../../ops/plus-v2/private-identity.mjs';
import {startNativeWorkbenchServer} from '../../../../ops/plus-v2/workbench-server.mjs';
export async function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'plus-governance-view-')),dbPath=join(dir,'platform.sqlite'),authPath=join(dir,'auth.json'),policyPath=join(dir,'policy.json');
  const tenantId='governance-test',principal={id:'reader',tenantId,roles:['viewer']},ctx={tenantId,actorId:principal.id};
  const records=['token-one','token-two'].map(token=>({...principal,tokenHash:createHash('sha256').update(token).digest('hex'),expiresAt:new Date(Date.now()+600000).toISOString()}));
  const policy={version:1,definitions:{},governanceView:{version:'plus-private-governance-view-v1',enabled:true,grants:[{principalId:principal.id,requiredRoles:['viewer'],permissions:['audit:read','jobs:read','host:read','object-audit:read'],actorIds:['reader']}]},objectBrowser:{version:'plus-private-object-browser-v1',enabled:true,grants:[{principalId:'reader',requiredRoles:['viewer'],objectType:'WorkItem',scopeField:'workspaceKey',workspaces:['allowed'],fields:['title']}]}};
  const save=()=>{writeFileSync(authPath,JSON.stringify(records),{mode:0o600});writeFileSync(policyPath,JSON.stringify(policy),{mode:0o600});};save();
  let storage=createNativeStorage(dbPath),host,gateway;const handles=[storage];t.after(async()=>{await gateway?.close();await host?.close();for(const s of handles)s.close();rmSync(dir,{recursive:true,force:true});});
  const baseline={odl:readFileSync(new URL('../../../domain-packs/plus-core/schema/metadata.odl',import.meta.url),'utf8')+'\ntype WorkItem @objectType {id:ID! @primary workspaceKey:String! title:String! secret:String!}',manifests:{},disabledActions:[]};
  await storage.applySchema(ctx,ontologyStorageSchema(buildOntologyBundle(baseline),1));const catalog=new NativeOntologyCatalog({storage,tenantId,authorize:async()=>true});await catalog.adoptInstalledBaseline(baseline,{id:'fixture-owner',tenantId,roles:['model_owner']});
  const root=await storage.createObject(ctx,'WorkItem',{workspaceKey:'allowed',title:'Original',secret:'PRIVATE_BUSINESS_DATA'});
  const denied=await storage.createObject(ctx,'WorkItem',{workspaceKey:'denied',title:'Hidden',secret:'HIDDEN_BUSINESS_DATA'});
  function audit(id,actorId='reader',extra={}){return {id:'audit_'+id,tenantId,timestamp:new Date().toISOString(),traceId:'trace_'+id,actor:{id:actorId,type:'user',roles:['viewer']},operation:{type:'action',actionType:'PlusTestAction',actionId:id},detail:{result:'success',after:{secret:'PRIVATE_TRAINING_MATERIAL'}},...extra};}
  const event=audit('act_native');const tx=await storage.beginTransaction(ctx);await tx.updateObject('WorkItem',root._id,{title:'Committed'},root._version);
  await createActionOutboxJournal().stage(tx,{version:'native-action-commit-v1',tenantId,actionId:'act_native',audit:event,affectedObjects:[{type:'WorkItem',id:root._id,changeType:'updated'}]});await tx.commit();
  const job=await storage.createObject(ctx,'PlusExecution',{executionKey:'recorded-job',kind:'MODEL_EVALUATION',inputReadSet:{secret:'PRIVATE_TRAINING_MATERIAL'},principalId:'reader',status:'PENDING',attempts:0,leaseToken:'PRIVATE_LEASE_TOKEN'});
  await storage.createObject(ctx,'PlusExecution',{executionKey:'hidden-job',kind:'MODEL_EVALUATION',inputReadSet:{},principalId:'hidden-actor',status:'FAILED',attempts:1});
  const identities=createPrivateIdentityProvider({authPath,tenantId}),loadPolicy=()=>JSON.parse(readFileSync(policyPath,'utf8'));
  async function start(workerIntervalMs=0){host??=await startPlusControlServer({dbPath,authPath,policyPath,tenantId,workerIntervalMs});gateway??=await startNativeWorkbenchServer({platformUrl:host.url});return host;}
  async function request(path,token='token-one',method='GET'){await start();const r=await fetch(gateway.url+'/api/governance/'+path,{method,headers:{authorization:'Bearer '+token}});return {status:r.status,body:await r.json()};}
  const options=()=>({storage,tenantId,identities,loadPolicy,catalog});
  return {get storage(){return storage;},root,denied,job,ctx,principal,policy,records,save,audit,identities,options,start,request,
    reopen:()=>{storage=createNativeStorage(dbPath);handles.push(storage);return storage;}};
}

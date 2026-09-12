import { digest } from '../../../packages/plus-contracts/dist/index.js';
import { NativePartitionLedger,NativeFeedbackRegistry,NativeDatasetRegistry,NativeRecipeRegistry,NativeTransitionEndpointReader,NativeTransitionPlanReader } from '../../../packages/plus-runtime/dist/index.js';
import { qualifiedNativeRead } from '../../../packages/plus-runtime/dist/read-qualification-phase.js';
import { createTaskEpisodeRuntime } from './task-episode.mjs';
import { validateRegisteredRecipe } from '../../../../services/plus-engine/estimator-registry.mjs';
import { compositionEstimatorId } from '../../../../services/plus-engine/native-composition-recipe.mjs';
import { learnedCompositionEstimatorId } from '../../../../services/plus-engine/learned-composition.mjs';
import { createPrivateAuthorizationRevision } from '../../../../ops/plus-v2/private-authority.mjs';
import { transitionEstimatorId,validateTransitionRecipe } from '../../../../services/plus-engine/transition-fit.mjs';

const GROUPING={version:'plus-task-grouping-v1',rootType:'InvestigationTask',parentType:'Matter',link:'MatterTask',direction:'inbound',namespace:'task-matter-v1',fields:['workspaceKey'],aliases:'reviewed-matter-aliases'};
export const taskGroupingPolicyHash=digest(GROUPING);
const PERMISSIONS=['partition:reserve','partition:read','feedback:propose','feedback:review','feedback:read','cohort:propose','cohort:review','cohort:read',
  'dataset:freeze','dataset:inspect','dataset:FIT','dataset:VALIDATE','dataset:FINAL_EVALUATE','recipe:draft','recipe:review','recipe:revoke','recipe:read','recipe:use'];
const DATA=PERMISSIONS.filter(p=>p.startsWith('dataset:')||p.startsWith('cohort:'));
const fail=code=>{throw Object.assign(new Error(code),{code});};
const key=v=>typeof v==='string'&&v.trim()===v&&v.length>0&&v.length<=256&&!/[\x00-\x1f\x7f]/.test(v);
const fields=(o,n)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).length===n.length&&n.every(k=>Object.hasOwn(o,k));
const list=(v,empty=false,max=100)=>Array.isArray(v)&&(empty||v.length>0)&&v.length<=max&&v.every(key)&&new Set(v).size===v.length;
const own=(o,k)=>o&&Object.hasOwn(o,k)?o[k]:undefined;

// Shared by the runtime and read-only operator planning. Configuration validity
// is not source qualification, model admission or construction of a CEL graph.
export function validateTaskLearningPolicy(raw){
    const v=structuredClone(raw);
    if(v===undefined||v?.enabled===false)fail('DATASET_TASK_POLICY_FORBIDDEN');
    if(!fields(v,['version','enabled','partition','groups','feedback','cohorts','recipes','grants'])||v.version!=='plus-task-learning-v1'||v.enabled!==true
      ||!fields(v.partition,['version','seed','groupingPolicyHash','boundaries'])||v.partition.version!=='plus-partition-v1'||!key(v.partition.seed)||v.partition.groupingPolicyHash!==taskGroupingPolicyHash
      ||!Array.isArray(v.partition.boundaries)||v.partition.boundaries.length!==4||v.partition.boundaries[3]!==10000
      ||v.partition.boundaries.some((n,i,a)=>!Number.isSafeInteger(n)||n<1||i>0&&n<=a[i-1]))fail('DATASET_TASK_CONFIGURATION_INVALID');
    for(const n of ['groups','feedback','cohorts','recipes','grants'])if(!Array.isArray(v[n])||v[n].length>500)fail('DATASET_TASK_CONFIGURATION_INVALID');
    const groups=new Set(),feedback=new Set(),cohorts=new Set(),recipes=new Set();
    for(const g of v.groups){
      if(!fields(g,['matterId','workspace','aliases'])||!key(g.matterId)||!key(g.workspace)||!Array.isArray(g.aliases)||g.aliases.length>100||groups.has(g.matterId))fail('DATASET_TASK_CONFIGURATION_INVALID');
      groups.add(g.matterId);const aliases=new Set();
      for(const a of g.aliases){if(!fields(a,['namespace','key'])||!key(a.namespace)||!key(a.key)||a.namespace===GROUPING.namespace||aliases.has(digest(a)))fail('DATASET_TASK_CONFIGURATION_INVALID');aliases.add(digest(a));}
    }
    for(const e of v.feedback){if(!fields(e,['workspace','policy'])||!key(e.workspace)||!key(e.policy?.key)||feedback.has(e.workspace))fail('DATASET_TASK_CONFIGURATION_INVALID');feedback.add(e.workspace);}
    for(const e of v.cohorts){if(!fields(e,['workspace','protocol'])||!key(e.workspace)||!key(e.protocol?.key)||cohorts.has(e.protocol.key))fail('DATASET_TASK_CONFIGURATION_INVALID');cohorts.add(e.protocol.key);}
    for(const e of v.recipes){if(!fields(e,['workspace','key','policy'])||!key(e.workspace)||!key(e.key)||!e.policy||recipes.has(e.key))fail('DATASET_TASK_CONFIGURATION_INVALID');recipes.add(e.key);}
    for(const g of v.grants){
      if(!fields(g,['principalId','requiredRoles','workspaces','permissions','protocolKeys','recipeKeys','types'])||!key(g.principalId)||!list(g.requiredRoles,false,32)||!list(g.workspaces)
        ||!list(g.permissions,false,PERMISSIONS.length)||g.permissions.some(p=>!PERMISSIONS.includes(p))||!list(g.protocolKeys,true)||!list(g.recipeKeys,true)
        ||!g.types||typeof g.types!=='object'||Array.isArray(g.types)||Object.keys(g.types).some(t=>!['InvestigationTask','Matter'].includes(t)))fail('DATASET_TASK_CONFIGURATION_INVALID');
      for(const type of Object.values(g.types))if(!fields(type,['read'])||!list(type.read,true)||type.read.some(f=>f!=='workspaceKey'))fail('DATASET_TASK_CONFIGURATION_INVALID');
    }
    return v;
}

/** Server-only Task data/recipe assembly. Native stores own all facts, approvals,
 * source qualifications and partitions. Policies configure use, never provide labels.
 * No public HTTP route, schema migration, synthetic data or approval is installed here.
 */
export function createTaskLearningServices({storage,catalog,definitions,tenantId,identities,loadPolicy,cel,clock,reauthenticate,compositionRecipes,componentDecisions,actionIntervals,validationActionIntervals,evaluationProtocols}={}){
  if(!key(tenantId)||typeof identities?.resolvePrincipal!=='function'||typeof loadPolicy!=='function'||clock!==undefined&&typeof clock!=='function'
    ||reauthenticate!==undefined&&typeof reauthenticate!=='function')fail('DATASET_TASK_CONFIGURATION_INVALID');
  const context={tenantId},timing=clock?{clock}:{};
  const load=()=>validateTaskLearningPolicy(loadPolicy()?.taskLearning);
  async function current(p){
    await reauthenticate?.();
    if(!p?.id||p.tenantId!==tenantId||!Array.isArray(p.roles))fail('DATASET_TASK_PRINCIPAL_FORBIDDEN');
    let now;try{now=await identities.resolvePrincipal(p.id);}catch(e){if(e?.code==='IDENTITY_FORBIDDEN')fail('DATASET_TASK_PRINCIPAL_FORBIDDEN');throw e;}
    if(now?.id!==p.id||now.tenantId!==tenantId||!Array.isArray(now.roles)||digest([...now.roles].sort())!==digest([...p.roles].sort()))fail('DATASET_TASK_PRINCIPAL_FORBIDDEN');
    await reauthenticate?.();
  }
  const has=(v,p,permissions,workspace,{protocol,recipe,matter=false}={})=>v.grants.some(g=>g.principalId===p.id&&g.requiredRoles.every(r=>p.roles.includes(r))
    &&permissions.some(permission=>g.permissions.includes(permission))&&(workspace===undefined||g.workspaces.includes(workspace))
    &&(!protocol||g.protocolKeys.includes(protocol))&&(!recipe||g.recipeKeys.includes(recipe))
    &&(workspace===undefined||own(g.types,'InvestigationTask')?.read.includes('workspaceKey'))&&(!matter||own(g.types,'Matter')?.read.includes('workspaceKey')));
  async function fence(v,p){await current(p);if(digest(load())!==digest(v))fail('DATASET_TASK_POLICY_STALE');}
  async function row(type,id){if(!key(id))fail('DATASET_TASK_INPUT_INVALID');const r=await storage.getObject(context,type,id);if(!r||r._tenantId!==tenantId||r._deletedAt)fail('DATASET_TASK_REFERENCE_FORBIDDEN');return r;}
  async function rootScope(reference,p){
    await current(p);if(reference?.tenantId!==tenantId||reference?.type!=='InvestigationTask')fail('DATASET_TASK_ROOT_FORBIDDEN');
    const r=await row('InvestigationTask',reference.id),d=loadPolicy()?.taskDomain;
    if(d?.enabled!==true||!key(r.workspaceKey)||!['SYNTHETIC','AUTHORIZED_REAL'].includes(r.dataClassification)||own(d.workspaceClassifications,r.workspaceKey)!==r.dataClassification)fail('DATASET_TASK_SCOPE_FORBIDDEN');
    return r;
  }
  async function snapshotScope(id,p){await current(p);const r=await row('PlusInputSnapshot',id);return rootScope(r.readSet?.root,p);}
  // Build per principal: background callers re-check their current account rather
  // than installing a no-op reauthentication callback or capturing a request token.
  const episodeFor=p=>createTaskEpisodeRuntime({storage,catalog,definitions,tenantId,loadPolicy,cel,...timing,reauthenticate:()=>current(p)});
  // Reuse only completed, identical reads inside the composition root's registered
  // authority/native-epoch phase. Keep per-principal runtime construction: no
  // request-token capture, persistent instance pool, shared unfinished work or
  // cross-phase source qualification. Current/describe/capture remain uncached.
  const historicalRead=async(operation,args,p,read)=>{
    await current(p);
    return qualifiedNativeRead(temporalInputs,storage,operation,args,p,read);
  };
  const episodes={
    readSnapshot:(id,p)=>historicalRead('episode:readSnapshot',{id},p,()=>episodeFor(p).readSnapshot(id,p)),
    inspectFeedback:(input,label,event,p)=>episodeFor(p).inspectFeedback(input,label,event,p),
  };
  const temporalInputs={readSnapshot:episodes.readSnapshot,
    readTemporalInput:(id,p)=>historicalRead('episode:readTemporalInput',{id},p,()=>episodeFor(p).readTemporalInput(id,p)),
    readCurrentTemporalInput:(id,p)=>episodeFor(p).readCurrentTemporalInput(id,p),
    readTemporalInputAsOf:(id,cutoff,p)=>historicalRead('episode:readTemporalInputAsOf',{id,cutoff},p,()=>episodeFor(p).readTemporalInputAsOf(id,cutoff,p)),
    describeCurrent:(id,p)=>episodeFor(p).describeCurrent(id,p),captureCurrent:(id,p)=>episodeFor(p).captureCurrent(id,p),
    snapshot:(input,p,key)=>episodeFor(p).snapshot(input,p,key)};
  async function snapshotPermission(p,permission,id){
    const v=load();await current(p);if(!has(v,p,[permission]))return false;
    const root=await snapshotScope(id,p),allowed=has(v,p,[permission],root.workspaceKey);await fence(v,p);return allowed;
  }
  const partitions=new NativePartitionLedger({storage,catalog,tenantId,episodes,...timing,
    authorize:snapshotPermission,
    protocolFor:async p=>{const v=load();await current(p);if(!has(v,p,['partition:reserve','partition:read']))fail('PARTITION_FORBIDDEN');await fence(v,p);return v.partition;},
    groupFor:async(p,reference)=>{
      const v=load(),root=await rootScope(reference,p);
      if(!has(v,p,['partition:reserve','partition:read'],root.workspaceKey,{matter:true}))fail('PARTITION_FORBIDDEN');
      const links=await storage.getLinks(context,root._id,'MatterTask','inbound',{limit:2});
      if(links.hasNextPage||links.totalCount!==1||links.items.length!==1||links.items[0]._toId!==root._id)fail('PARTITION_TASK_PARENT_INVALID');
      const matter=await row('Matter',links.items[0]._fromId),group=v.groups.find(g=>g.matterId===matter._id&&g.workspace===root.workspaceKey);
      if(matter.workspaceKey!==root.workspaceKey||!group)fail('PARTITION_TASK_GROUP_FORBIDDEN');
      await fence(v,p);return {primary:{namespace:GROUPING.namespace,key:digest([root.workspaceKey,matter._id])},aliases:group.aliases};
    },
  });
  async function feedbackScope(input,p){
    const first=await snapshotScope(input.inputSnapshotId,p),second=await snapshotScope(input.labelSnapshotId,p);
    if(first._id!==second._id||first.workspaceKey!==second.workspaceKey)fail('FEEDBACK_TASK_SCOPE_FORBIDDEN');return first.workspaceKey;
  }
  const feedback=new NativeFeedbackRegistry({storage,tenantId,episodes,partitions,...timing,
    discovery:{authorizationRevision:p=>createPrivateAuthorizationRevision({identities,loadPolicy,tenantId,reauthenticate})(p),
      authorizeProposalRoot:async(p,reference)=>{const v=load();await current(p);if(!has(v,p,['feedback:propose']))return false;
        const root=await rootScope({tenantId,...reference},p),allowed=has(v,p,['feedback:propose'],root.workspaceKey);await fence(v,p);return allowed;},
      authorizeRoot:async(p,reference)=>{const v=load();await current(p);if(!has(v,p,['feedback:read']))return false;
        const root=await rootScope({tenantId,...reference},p),allowed=has(v,p,['feedback:read'],root.workspaceKey);await fence(v,p);return allowed;}},
    authorize:async(p,permission,input)=>{const v=load();await current(p);if(!has(v,p,[permission]))return false;const scope=await feedbackScope(input,p),allowed=has(v,p,[permission],scope);await fence(v,p);return allowed;},
    policyFor:async(p,input)=>{const v=load(),scope=await feedbackScope(input,p),entry=v.feedback.find(e=>e.workspace===scope);
      if(!entry||!has(v,p,['feedback:propose','feedback:review','feedback:read'],scope))fail('FEEDBACK_FORBIDDEN');await fence(v,p);return entry.policy;},
  });
  function datasetFor(protocolKey){
    const scope=load().cohorts.find(e=>e.protocol.key===protocolKey)?.workspace;if(!scope)fail('DATASET_TASK_PROTOCOL_FORBIDDEN');
    const scopedEpisodes={readSnapshot:async(id,p)=>{if((await snapshotScope(id,p)).workspaceKey!==scope)fail('DATASET_TASK_SCOPE_FORBIDDEN');return episodes.readSnapshot(id,p);}};
    return new NativeDatasetRegistry({storage,tenantId,episodes:scopedEpisodes,partitions,feedback,...timing,
      discovery:{authorizationRevision:p=>createPrivateAuthorizationRevision({identities,loadPolicy,tenantId,reauthenticate})(p),
        authorizeProposalRoot:async(p,reference)=>{const v=load();await current(p);const root=await rootScope({tenantId,...reference},p);
          const allowed=root.workspaceKey===scope&&has(v,p,['cohort:propose'],scope,{protocol:protocolKey});await fence(v,p);return allowed;},
        authorizeRoot:async(p,reference)=>{const v=load();await current(p);const root=await rootScope({tenantId,...reference},p);
          const allowed=root.workspaceKey===scope&&has(v,p,['cohort:read'],scope,{protocol:protocolKey});await fence(v,p);return allowed;}},
      authorize:async(p,permission,key)=>{const v=load();await current(p);const e=v.cohorts.find(e=>e.protocol.key===key);
        const allowed=key===protocolKey&&e?.workspace===scope&&has(v,p,[permission],scope,{protocol:key});await fence(v,p);return allowed;},
      protocolFor:async(p,key)=>{const v=load();await current(p);const e=v.cohorts.find(e=>e.protocol.key===key);
        if(key!==protocolKey||e?.workspace!==scope||!has(v,p,DATA,scope,{protocol:key}))fail('DATASET_FORBIDDEN');
        const classification=own(loadPolicy()?.taskDomain?.workspaceClassifications,scope);if(e.protocol.classification!==classification)fail('DATASET_TASK_SCOPE_FORBIDDEN');
        await fence(v,p);return e.protocol;},
    });
  }
  async function forRecord(type,id,p){await current(p);const r=await row(type,id),key=type==='PlusCohort'?r.protocolKey:r.sourceManifest?.protocol?.key;if(!key)fail('DATASET_TASK_REFERENCE_FORBIDDEN');return datasetFor(key);}
  const datasets={
    frozenForRoot:async(raw,p)=>{
      if(!fields(raw,['type','id'])||Object.values(raw).some(v=>typeof v!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(v)))fail('DATASET_TASK_INPUT_INVALID');
      if(!storage.getReadRevision)fail('DATASET_READ_GUARD_REQUIRED');
      p=structuredClone(p);const reference=structuredClone(raw),epoch=await storage.getReadRevision(context),authority=createPrivateAuthorizationRevision({identities,loadPolicy,tenantId,reauthenticate});
      const started=(clock??Date.now)();if(!Number.isFinite(started))fail('DATASET_INVALID_CLOCK');
      const revision=await authority(p),v=load(),root=await rootScope({tenantId,...reference},p);
      if(!has(v,p,['cohort:read'],root.workspaceKey)||!has(v,p,['dataset:inspect'],root.workspaceKey))fail('DATASET_FORBIDDEN');
      const entries=v.cohorts.filter(e=>e.workspace===root.workspaceKey&&has(v,p,['cohort:read'],e.workspace,{protocol:e.protocol.key})&&has(v,p,['dataset:inspect'],e.workspace,{protocol:e.protocol.key}));
      if(entries.length>32)fail('DATASET_COLLECTION_LIMIT');
      const items=[];for(const entry of entries){const item=await datasetFor(entry.protocol.key).discoverFrozen(entry.protocol.key,reference,p);if(item)items.push(item);}
      await fence(v,p);if(await authority(p)!==revision)fail('DATASET_AUTHORITY_STALE');if(await storage.getReadRevision(context)!==epoch)fail('CONFLICT');
      const ended=(clock??Date.now)();if(!Number.isFinite(ended)||ended<started)fail('DATASET_INVALID_CLOCK');
      if(new Set(items.map(i=>i.id)).size!==items.length)fail('DATASET_INTEGRITY_ERROR');items.sort((a,b)=>a.protocolKey.localeCompare(b.protocolKey));
      return {schema:'plus-frozen-dataset-root-index-v1',root:{...reference,version:root._version},items,observedAt:new Date(ended).toISOString(),readOnly:true,trainingEligible:false};
    },
    proposalOptions:async(raw,p)=>{
      if(!fields(raw,['type','id'])||Object.values(raw).some(v=>typeof v!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(v)))fail('DATASET_TASK_INPUT_INVALID');
      if(!storage.getReadRevision)fail('DATASET_READ_GUARD_REQUIRED');
      const reference=structuredClone(raw),epoch=await storage.getReadRevision(context),authority=createPrivateAuthorizationRevision({identities,loadPolicy,tenantId,reauthenticate});
      const started=(clock??Date.now)();if(!Number.isFinite(started))fail('DATASET_INVALID_CLOCK');
      const revision=await authority(p),v=load(),root=await rootScope({tenantId,...reference},p);
      if(!p.roles.includes('trainer')||!has(v,p,['cohort:propose'],root.workspaceKey))fail('DATASET_FORBIDDEN');
      const entries=v.cohorts.filter(e=>e.workspace===root.workspaceKey&&has(v,p,['cohort:propose'],e.workspace,{protocol:e.protocol.key}));
      if(entries.length>32)fail('DATASET_COLLECTION_LIMIT');
      const items=[];for(const entry of entries)items.push(await datasetFor(entry.protocol.key).proposalOptions(entry.protocol.key,reference,p));
      await fence(v,p);if(await authority(p)!==revision)fail('DATASET_AUTHORITY_STALE');if(await storage.getReadRevision(context)!==epoch)fail('CONFLICT');
      const ended=(clock??Date.now)();if(!Number.isFinite(ended)||ended<started)fail('DATASET_INVALID_CLOCK');
      if(items.some(e=>e.enrollmentOpen&&ended>=Date.parse(e.protocol.labelReceivedFrom)))fail('DATASET_ENROLLMENT_CLOSED');
      items.sort((a,b)=>a.protocol.key.localeCompare(b.protocol.key));
      return {schema:'plus-cohort-proposal-options-v1',root:{...reference,version:root._version},items,readOnly:true,trainingEligible:false};
    },
    listForRoot:async(raw,p)=>{
      if(!fields(raw,['type','id'])||Object.values(raw).some(v=>typeof v!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(v)))fail('DATASET_TASK_INPUT_INVALID');
      if(!storage.getReadRevision)fail('DATASET_READ_GUARD_REQUIRED');
      const reference=structuredClone(raw),epoch=await storage.getReadRevision(context),authority=createPrivateAuthorizationRevision({identities,loadPolicy,tenantId,reauthenticate});
      const revision=await authority(p),v=load(),root=await rootScope({tenantId,...reference},p);
      if(!has(v,p,['cohort:read'],root.workspaceKey))fail('DATASET_FORBIDDEN');
      const entries=v.cohorts.filter(e=>e.workspace===root.workspaceKey&&has(v,p,['cohort:read'],e.workspace,{protocol:e.protocol.key}));
      if(entries.length>32)fail('DATASET_COLLECTION_LIMIT');
      const items=[];for(const entry of entries){const item=await datasetFor(entry.protocol.key).discoverCohort(entry.protocol.key,reference,p);if(item)items.push(item);}
      await fence(v,p);if(await authority(p)!==revision)fail('DATASET_AUTHORITY_STALE');if(await storage.getReadRevision(context)!==epoch)fail('CONFLICT');
      items.sort((a,b)=>a.protocolKey.localeCompare(b.protocolKey));
      return {schema:'plus-cohort-root-index-v1',root:{...reference,version:root._version},items,readOnly:true,trainingEligible:false};
    },
    proposeCohort:async(key,ids,p)=>datasetFor(key).proposeCohort(key,ids,p),
    readCohort:async(id,p)=>(await forRecord('PlusCohort',id,p)).readCohort(id,p),
    frozenMetadata:async(id,p)=>(await forRecord('PlusCohort',id,p)).frozenMetadata(id,p),
    reviewCohort:async(id,version,decision,reason,p)=>(await forRecord('PlusCohort',id,p)).reviewCohort(id,version,decision,reason,p),
    freeze:async(id,p)=>(await forRecord('PlusCohort',id,p)).freeze(id,p),
    inspect:async(id,p)=>qualifiedNativeRead(datasets,storage,'dataset:inspect',{id},p,
      async()=>(await forRecord('PlusDatasetRevision',id,p)).inspect(id,p)),
    // forRecord constructs a scoped registry per invocation. Register this
    // stable same-graph adapter, not a transient inner instance. Only the fully
    // completed native read may be reused inside the enclosing fenced phase.
    materialize:async(id,purpose,p)=>qualifiedNativeRead(datasets,storage,'dataset:materialize',{id,purpose},p,
      async()=>(await forRecord('PlusDatasetRevision',id,p)).materialize(id,purpose,p)),
  };
  const recipes=new NativeRecipeRegistry({storage,tenantId,definitions,componentDecisions,...timing,
    // Metadata requires strong authority when called; merely assembling older
    // unrelated services must not eagerly invoke the new capability's guard.
    authorizationRevision:p=>createPrivateAuthorizationRevision({tenantId,identities,loadPolicy,reauthenticate})(p),
    validateRecipe:async(payload,compiled,p)=>{if([compositionEstimatorId,learnedCompositionEstimatorId].includes(payload?.engineId)){
      if(!compositionRecipes)fail('COMPOSITION_RECIPE_QUALIFIER_REQUIRED');return compositionRecipes.validateRecipe(payload,compiled,p);
    }if(payload?.engineId===transitionEstimatorId)return validateTransitionRecipe(payload,compiled);
    return validateRegisteredRecipe(payload,compiled);},
    ...(compositionRecipes?{qualifyDependencies:compositionRecipes.qualifyDependencies,dependencyAuthorizationRevision:compositionRecipes.authorizationRevision}:{}),
    authorize:async(p,permission,key)=>{const v=load();await current(p);const e=v.recipes.find(e=>e.key===key),allowed=!!e&&has(v,p,[permission],e.workspace,{recipe:key});await fence(v,p);return allowed;},
    policyFor:async(p,key)=>{const v=load();await current(p);const e=v.recipes.find(e=>e.key===key);
      if(!e||!has(v,p,PERMISSIONS.filter(p=>p.startsWith('recipe:')),e.workspace,{recipe:key}))fail('RECIPE_FORBIDDEN');await fence(v,p);return e.policy;},
  });
  // Private read-only normalization, not a new HTTP route or a transition FIT
  // registration. Legacy callers need no new identity interface until using it.
  const transitionEndpoints={read:async(ids,purpose,p)=>{
    const authority=createPrivateAuthorizationRevision({tenantId,identities,loadPolicy,reauthenticate});
    const reader=new NativeTransitionEndpointReader({storage,tenantId,datasets,feedback,episodes,partitions,authorizationRevision:authority,
      authorize:async(p,purpose,id)=>{const v=load();await current(p);const record=await row('PlusDatasetRevision',id),key=record.sourceManifest?.protocol?.key;
        const entry=v.cohorts.find(e=>e.protocol.key===key),allowed=!!entry&&has(v,p,['dataset:'+purpose],entry.workspace,{protocol:key});
        await fence(v,p);return allowed;}});
    return reader.read(ids,purpose,p);
  }};
  const transitionPlanReader=()=>{
    const authorizationRevision=createPrivateAuthorizationRevision({tenantId,identities,loadPolicy,reauthenticate});
    return new NativeTransitionPlanReader({storage,tenantId,recipes,endpoints:transitionEndpoints,authorizationRevision,episodes:temporalInputs,
      actionIntervals,validationActionIntervals,evaluationProtocols});
  };
  const transitionPlans={read:(hash,ids,p)=>transitionPlanReader().read(hash,ids,p),readWithContext:(hash,ids,p)=>transitionPlanReader().readWithContext(hash,ids,p),
    readWithActions:(hash,ids,p)=>transitionPlanReader().readWithActions(hash,ids,p),
    materializeForFit:(hash,ids,p)=>transitionPlanReader().materializeForFit(hash,ids,p),
    revalidateForFit:(saved,hash,ids,p)=>transitionPlanReader().revalidateForFit(saved,hash,ids,p),
    materializeForValidation:(protocolId,ids,p)=>transitionPlanReader().materializeForValidation(protocolId,ids,p),
    revalidateForValidation:(saved,protocolId,ids,p)=>transitionPlanReader().revalidateForValidation(saved,protocolId,ids,p)};
  const recipeKeysForRoot=async(raw,p)=>{
    if(!fields(raw,['type','id']))fail('DATASET_TASK_INPUT_INVALID');
    const authority=createPrivateAuthorizationRevision({identities,loadPolicy,tenantId,reauthenticate}),revision=await authority(p),v=load(),epoch=await storage.getReadRevision(context);
    const root=await rootScope({tenantId,...raw},p);
    if(!has(v,p,['recipe:read'],root.workspaceKey))fail('RECIPE_FORBIDDEN');
    const keys=v.recipes.filter(e=>e.workspace===root.workspaceKey&&has(v,p,['recipe:read'],e.workspace,{recipe:e.key})).map(e=>e.key).sort();
    if(keys.length>32)fail('RECIPE_COLLECTION_LIMIT');await fence(v,p);if(await authority(p)!==revision)fail('RECIPE_AUTHORITY_STALE');if(await storage.getReadRevision(context)!==epoch)fail('CONFLICT');return keys;
  };
  const recipeWorkbenchPurposes=async p=>{
    const authority=createPrivateAuthorizationRevision({identities,loadPolicy,tenantId,reauthenticate}),revision=await authority(p),v=load();
    const items=v.recipes.filter(e=>has(v,p,['recipe:read'],e.workspace,{recipe:e.key})).map(e=>({...structuredClone(e),
      canDraft:p.roles.includes('trainer')&&has(v,p,['recipe:draft'],e.workspace,{recipe:e.key}),
      canReview:p.roles.includes('model_owner')&&has(v,p,['recipe:review'],e.workspace,{recipe:e.key}),
      cohorts:v.cohorts.filter(c=>c.workspace===e.workspace&&has(v,p,['cohort:read'],c.workspace,{protocol:c.protocol.key})).map(c=>structuredClone(c.protocol))}));
    if(items.length>32)fail('RECIPE_COLLECTION_LIMIT');await fence(v,p);if(await authority(p)!==revision)fail('RECIPE_AUTHORITY_STALE');return items;
  };
  return {partitions,feedback,datasets,recipes,recipeKeysForRoot,recipeWorkbenchPurposes,temporalInputs,transitionEndpoints,transitionPlans,assertConfigured:()=>{load();},predictionReady:false};
}

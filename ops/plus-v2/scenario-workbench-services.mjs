import {digest} from '../../platform/packages/plus-contracts/dist/index.js';
import {createPrivateObjectReader} from './object-read-services.mjs';
const fail=code=>{throw Object.assign(Error(code),{code});};
const fields=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const name=v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(v);
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const ref=r=>({id:r._id,version:r._version,hash:digest(r)});

// Native workbench discovery/recovery, not another scenario store. Root browse,
// scenario purpose and belief-history permissions are independent. No model
// material is calculated just to populate a list or resolve an original key.
export function createPrivateScenarioWorkbench(options){
  const {storage,tenantId,catalog,beliefs,scenarios,access}=options,objects=createPrivateObjectReader(options);
  async function prepare(raw,principal){
    if(!fields(raw,['rootType','rootId'])||!name(raw.rootType)||!id(raw.rootId))fail('SCENARIO_WORKBENCH_INVALID_INPUT');
    const p=structuredClone(principal),ctx={tenantId,actorId:p?.id},authority=await access.authorizationRevision(p),epoch=await storage.getReadRevision(ctx);
    const root=await objects.read(raw.rootType,raw.rootId,p),current=await catalog.read(p);
    return {p,ctx,authority,epoch,root:root.reference,current};
  }
  async function fence(s){if(await access.authorizationRevision(s.p)!==s.authority)fail('SCENARIO_WORKBENCH_AUTHORITY_STALE');if(await storage.getReadRevision(s.ctx)!==s.epoch)fail('CONFLICT');}
  async function episode(s,episodeId){
    const e=await storage.getObject(s.ctx,'PlusEpisode',episodeId),r=e?.rootReference;
    if(!e||e._deletedAt||e._tenantId!==tenantId||e._type!=='PlusEpisode'||e._id!==episodeId)fail('SCENARIO_WORKBENCH_EPISODE_INVALID');
    if(r?.tenantId!==tenantId||r.type!==s.root.type||r.id!==s.root.id)return null;
    const binding=e.binding,link=s.current.bundle.parsed.linkTypes.find(l=>l.name===binding?.rootEpisodeLink);
    if(binding?.rootType!==s.root.type||digest(binding)!==e.bindingHash||!link||link.from!==s.root.type||link.to!=='PlusEpisode')fail('SCENARIO_WORKBENCH_EPISODE_INVALID');
    const page=await storage.getLinks(s.ctx,e._id,link.name,'inbound',{limit:2});
    if(page.hasNextPage||page.totalCount!==1||page.items.length!==1)fail('SCENARIO_WORKBENCH_EPISODE_INVALID');
    const edge=page.items[0];if(edge._tenantId!==tenantId||edge._type!==link.name||edge._fromType!==r.type||edge._fromId!==r.id||edge._toType!=='PlusEpisode'||edge._toId!==e._id)fail('SCENARIO_WORKBENCH_EPISODE_INVALID');
    return e;
  }
  async function bindScenario(s,row){
    const input=row.plans?.input;
    if(!input||!await access.authorize(s.p,'scenario:read',input.key,input.episodeId))fail('SCENARIO_FORBIDDEN');
    const e=await episode(s,input.episodeId);if(!e||e.classification!==row.classification)fail('SCENARIO_WORKBENCH_ROOT_MISMATCH');
    return e;
  }
  return {async options(raw,p){
    const s=await prepare(raw,p),items=[];
    for(const target of await access.listTargets(s.p)){
      const e=await episode(s,target.episodeId);if(!e)continue;
      const policy=await access.policyFor(s.p,target.key,target.episodeId);if(!policy.classifications.includes(e.classification))continue;
      const value=await beliefs.readHeadMetadata(target.key,target.episodeId,s.p);
      if(value.schema!=='plus-belief-head-metadata-v1'||value.readOnly!==true||value.currentBasisChecked!==false||value.predictionReady!==false||value.qualification!=='NOT_CHECKED')fail('SCENARIO_WORKBENCH_METADATA_INVALID');
      const b=value.item,reasons=[];if(e.status!=='OPEN')reasons.push('EPISODE_'+e.status);if(!b)reasons.push('BELIEF_NOT_REGISTERED');
      if(b&&b.classification!==e.classification)fail('SCENARIO_WORKBENCH_METADATA_INVALID');
      if(b&&b.recordedReadiness!=='READY')reasons.push('BELIEF_'+b.recordedReadiness);if(!target.mayCompare)reasons.push('SCENARIO_COMPARE_NOT_GRANTED');
      const item={key:target.key,root:s.root,episode:ref(e),classification:e.classification,head:b,unavailableReasons:reasons,
        ...(policy.version==='plus-verification-scenario-policy-v2'?{adaptiveAssumptions:policy.adaptiveAssumptions.map(a=>({...structuredClone(a),assumptionHash:digest(a)}))}:{}),
        qualification:'NOT_CHECKED',predictionReady:false,command:reasons.length?null:{key:target.key,episodeId:e._id,beliefId:b.belief.id}};
      items.push({optionKey:digest(item),...item});
    }
    await fence(s);items.sort((a,b)=>a.optionKey.localeCompare(b.optionKey));
    return {schema:'plus-scenario-workbench-options-v1',root:s.root,items,readOnly:true,qualification:'NOT_CHECKED',predictionReady:false,executionAuthorized:false};
  },async lookup(raw,p){
    if(!fields(raw,['rootType','rootId','requestKey'])||typeof raw.requestKey!=='string'||!raw.requestKey.trim()||raw.requestKey.length>256)fail('SCENARIO_WORKBENCH_INVALID_INPUT');
    const s=await prepare({rootType:raw.rootType,rootId:raw.rootId},p),key=digest([tenantId,s.p.id,raw.requestKey]);
    const page=await storage.queryObjects(s.ctx,'PlusScenarioRun',{field:'scenarioKey',operator:'eq',value:key},{limit:2});
    if(page.hasNextPage||page.totalCount>1||page.items.length!==page.totalCount)fail('SCENARIO_WORKBENCH_INTEGRITY');let item=null;
    if(page.items.length){const row=page.items[0],e=await bindScenario(s,row),v=await scenarios.readHistory(row._id,s.p);
      if(v.readOnly!==true||v.nativeAdmissionChecked!==false||v.currentBasisChecked!==false||v.predictionReady!==false||digest(v.record)!==digest(row)||row.plans.createdBy!==s.p.id||row.scenarioKey!==key||row.plans.input.requestKey!==raw.requestKey)fail('SCENARIO_WORKBENCH_INTEGRITY');
      item={id:row._id,version:row._version,hash:row.contentHash,episode:ref(e),createdAt:row.plans.createdAt,recordedReadiness:row.readiness,qualification:'NOT_CHECKED'};
    }
    await fence(s);return {schema:'plus-scenario-workbench-lookup-v1',root:s.root,item,readOnly:true,absenceIsNotCancellation:true,predictionReady:false,executionAuthorized:false};
  },async view(raw,p){
    if(!fields(raw,['rootType','rootId','scenarioId'])||!id(raw.scenarioId))fail('SCENARIO_WORKBENCH_INVALID_INPUT');
    const s=await prepare({rootType:raw.rootType,rootId:raw.rootId},p),row=await storage.getObject(s.ctx,'PlusScenarioRun',raw.scenarioId);
    if(!row||row._tenantId!==tenantId||row._deletedAt)fail('SCENARIO_NOT_FOUND');await bindScenario(s,row);
    const v=await scenarios.read(row._id,s.p);if(v.nativeAdmissionChecked!==true||digest(v.record)!==digest(row)||v.businessFactsWritten!==false||v.executionAuthorized!==false)fail('SCENARIO_WORKBENCH_INTEGRITY');
    const b=row.plans.readSet;await fence(s);
    return {schema:'plus-scenario-workbench-result-v1',root:s.root,scenario:{id:row._id,version:row._version,hash:row.contentHash,createdAt:row.plans.createdAt},
      key:row.plans.input.key,episodeId:row.plans.input.episodeId,classification:row.classification,predictions:structuredClone(row.predictions),
      basis:{belief:b.belief,definition:b.definition,recipe:b.recipe,release:b.release,selection:b.selection,utilityHash:b.utilityHash,plannerId:b.plannerId},
      readOnly:true,nativeAdmissionChecked:true,currentBasisChecked:true,businessFactsWritten:false,executionAuthorized:false};
  }};
}

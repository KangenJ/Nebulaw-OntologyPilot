import { digest } from '../../../packages/plus-contracts/dist/index.js';
import { NativeEpisodeRuntime,sourceEventDigest } from '../../../packages/plus-runtime/dist/index.js';
import { taskEpisodeBinding } from '../../../domain-packs/lwm-plus/mechanisms/task-mechanism.mjs';
import { taskSourceGovernanceAdapter } from './task-source-governance.mjs';
import { approvedSourceChanges } from '../../../packages/plus-runtime/dist/source-lineage.js';
import { createPrivateAuthorizationRevision } from '../../../../ops/plus-v2/private-authority.mjs';

const deny=()=>{throw Object.assign(new Error('EPISODE_SOURCE_FORBIDDEN'),{code:'EPISODE_SOURCE_FORBIDDEN'});};
const own=(o,k)=>o&&Object.hasOwn(o,k)?o[k]:undefined;
/** Domain-specific source semantics. Core episode runtime has no legal/task type constants.
 * Grants are read-only, independent of action grants; credentials and current policy are rechecked on every call.
 */
export function createTaskEpisodeRuntime({storage,catalog,definitions,tenantId,loadPolicy,reauthenticate,identities,cel,clock}){
  const binding=taskEpisodeBinding(),context={tenantId};
  async function domain(p){await reauthenticate();const d=loadPolicy().taskDomain;return p.tenantId===tenantId&&d?.enabled===true?d:undefined;}
  async function get(type,id){const o=await storage.getObject(context,type,id);if(!o||o._deletedAt||o._tenantId!==tenantId)deny();return o;}
  async function rootOf(id,linkType,rootId){const links=await storage.getLinks(context,id,linkType,'inbound',{limit:2});return links.totalCount===1&&links.items[0]?._fromId===rootId;}
  async function authorize(p,permission,access){
    const d=await domain(p);if(!d||access.root.type!==binding.rootType||!Array.isArray(d.episodeGrants))return false;
    const root=await get(binding.rootType,access.root.id);
    for(const grant of d.episodeGrants.filter(g=>g.principalId===p.id&&g.permissions?.includes(permission))){
      if(!grant.workspaces?.includes(root.workspaceKey)||!grant.types)continue;
      const rootFields=own(grant.types,binding.rootType)?.read;
      if(!Array.isArray(rootFields)||!rootFields.includes('workspaceKey'))continue;
      if(Object.entries(access.fields).some(([type,fields])=>!Array.isArray(own(grant.types,type)?.read)||fields.some(name=>!own(grant.types,type).read.includes(name))))continue;
      let allowed=true;
      for(const reference of access.sources){
        if(reference.tenantId!==tenantId){allowed=false;break;}
        const rule=binding.sources.find(r=>r.sourceType===reference.type);if(!rule){allowed=false;break;}
        const source=await get(reference.type,reference.id);
        if(!await rootOf(source._id,rule.rootSourceLink,root._id)||source.workspaceKey!==undefined&&source.workspaceKey!==root.workspaceKey){allowed=false;break;}
      }
      if(allowed)return true;
    }
    return false;
  }
  async function qualifySource(p,{root,event,source,rule}){
    const d=await domain(p);if(!d)deny();
    if(own(d.workspaceClassifications,root.workspaceKey)!==root.dataClassification)deny();
    const classification=root.dataClassification;
    if(rule.kind==='OBSERVATION'){
      const policy=own(d.sources,source.sourceSystem);
      if(!policy||policy.classification!==classification||!policy.channelKeys?.includes(source.channelKey)||source.workspaceKey!==root.workspaceKey||source.dataClassification!==classification
        ||event.sourceSystem!==source.sourceSystem||event.sourceRecordId!==source.sourceRecordId||event.sourceRevision!==source.sourceRevision
        ||event.sourceKey!==source.sourceEventKey||source.sourceEventKey!==digest([tenantId,source.sourceSystem,source.sourceRecordId,source.sourceRevision]))deny();
      return {allowed:true,policyHash:digest(policy),dependenceKey:digest([tenantId,source.sourceSystem,source.sourceRecordId]),verificationMode:'NONE',learningEligible:false};
    }
    const verification=event.verification,method=own(d.verificationMethods,source.methodKey),ref=verification?.observation;
    // Native eligibility is authoritative even if an imported/inconsistent Plus flag was not updated.
    const currentCheck=await get('TaskCompletionVerification',source._id);if(currentCheck.validity==='REVOKED')deny();
    if(!method||!ref||ref.type!=='Observation'||ref.tenantId!==tenantId||!Number.isSafeInteger(ref.version)||ref.version<1
      ||ref.version!==source.observationVersion||!ref.schemaRevision||source.classification!==classification
      ||!['GOLD','NOISY'].includes(method.mode)||!method.classifications?.includes(classification)||method.mode!==source.mode
      ||method.mode!==verification.mode||method.policyRef!==verification.policyRef||digest(method)!==verification.policyHash
      ||verification.verifiedBy!==source.recordedBy||verification.targetTime!==source.targetTime
      ||event.sourceSystem!=='native.task-verification'||event.sourceRecordId!==source._id||event.sourceRevision!==String(source._version)
      ||event.sourceKey!==digest([tenantId,'native.task-verification',source._id,String(source._version)]))deny();
    // The observation referenced by a check is itself authorized before its historical fields are read.
    const readFields={Observation:binding.sources[0].qualificationFields.concat(['reportedCompletion','observedAt','receivedAt'])};
    if(!await authorize(p,'episode:read',{root:{type:root._type,id:root._id},fields:readFields,sources:[ref]}))deny();
    const observation=await storage.getObjectAtVersion(context,'Observation',ref.id,ref.version);
    const checkLinks=await storage.getLinks(context,source._id,'ObservationCompletionCheck','inbound',{limit:2});
    if(!observation||observation._deletedAt||observation._tenantId!==tenantId||observation._version!==ref.version
      ||checkLinks.totalCount!==1||checkLinks.items[0]?._fromId!==ref.id||observation.workspaceKey!==root.workspaceKey
      ||observation.recordedBy===source.recordedBy||source.targetTime!==observation.observedAt||observation.dataClassification!==classification)deny();
    if(!Number.isSafeInteger(source.taskVersion)||source.taskVersion<1||!await storage.getObjectAtVersion(context,root._type,root._id,source.taskVersion))deny();
    const originalEvents=await storage.queryObjects(context,'PlusEvent',{field:'sourceKey',operator:'eq',value:observation.sourceEventKey},{limit:2});
    const original=originalEvents.items[0];
    if(originalEvents.totalCount!==1||original.revoked||sourceEventDigest(original)!==original.contentHash
      ||original.sourceReference?.type!=='Observation'||original.sourceReference.id!==ref.id||original.sourceReference.version!==ref.version
      ||!await rootOf(original._id,binding.rootEventLink,root._id))deny();
    if((await approvedSourceChanges(storage,context,[original._id,event._id])).length)deny();
    // A revoked/unapproved original channel cannot silently re-enter through its verification derivative.
    const channel=own(d.sources,observation.sourceSystem);
    if(!channel||channel.classification!==classification||!channel.channelKeys?.includes(observation.channelKey))deny();
    return {allowed:true,policyHash:digest({method,channel}),dependenceKey:digest([tenantId,observation.sourceSystem,observation.sourceRecordId]),verificationMode:method.mode,
      learningEligible:method.mode==='GOLD'&&classification!=='IMPORTED_UNVERIFIED'};
  }
  const governance=taskSourceGovernanceAdapter({storage,catalog,tenantId,cel,domain,authorize,qualifySource,binding});
  async function qualifyContextHistory(p,{root,versions}){
    const d=structuredClone(await domain(p));if(!d)deny();
    const current=await get(binding.rootType,root._id);
    // Cross-workspace historical transfers need their own reviewed migration;
    // permission to today's task must not reveal values from its former scope.
    if(root.workspaceKey!==current.workspaceKey||root.dataClassification!==current.dataClassification
      ||own(d.workspaceClassifications,root.workspaceKey)!==root.dataClassification
      ||versions.some(v=>v.workspaceKey!==root.workspaceKey||v.dataClassification!==root.dataClassification))deny();
    // Qualification semantics persist in provenance; credential/grant revisions
    // only fence THIS read. A valid credential rotation must not rewrite history
    // or make an unchanged past model score permanently unreviewable.
    const authorizationHash=digest(d),policyHash=digest({workspaceClassifications:d.workspaceClassifications,sources:d.sources,verificationMethods:d.verificationMethods});
    const latest=await domain(p);if(!latest||digest(latest)!==authorizationHash)deny();
    return {allowed:true,policyHash,authorizationHash};
  }
  return new NativeEpisodeRuntime({storage,catalog,definitions,tenantId,authorize,qualifySource,qualifyContextHistory,...governance,...(clock?{clock}:{}),
    discovery:{authorizationRevision:p=>createPrivateAuthorizationRevision({identities,loadPolicy,tenantId,reauthenticate})(p)},bindingFor:compiled=>{
    if(compiled.definition.key!=='task.completion')throw Object.assign(new Error('EPISODE_BINDING_NOT_CONFIGURED'),{code:'EPISODE_BINDING_NOT_CONFIGURED'});
    return structuredClone(binding);
  }});
}

import {digest} from '../../platform/packages/plus-contracts/dist/index.js';
import {createPrivateModelEvaluationJobAccess} from './model-evaluation-job-services.mjs';

const fail=code=>{throw Object.assign(Error(code),{code});};
const reference=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);

/** Server-owned metadata composition. No FIT/scoring/material export, no labels,
 * mutable thresholds or automatic approval, and no second dataset catalogue. */
export function createPrivateEvaluationSubmissionCatalog(options){
  const {storage,tenantId,compute,protocols,datasets,clock,authorizeEvaluation}=options,access=createPrivateModelEvaluationJobAccess(options);
  if(typeof storage?.getReadRevision!=='function'||typeof compute?.listSubmitted!=='function'||typeof protocols?.listMetadata!=='function'
    ||typeof datasets?.frozenMetadata!=='function'||typeof authorizeEvaluation!=='function')fail('EVALUATION_OPTIONS_PROVIDER_REQUIRED');
  // The actual private evaluation graph supplies its own current read/run gate.
  // Native protocol metadata resolves the recipe policy; no alternate resolver.
  async function keys(p){const result=[];
    for(const key of await access.submissionKeys(p))if(await authorizeEvaluation(p,'evaluation:read',key)&&await authorizeEvaluation(p,'evaluation:run',key))result.push(key);
    return result;
  }
  return {async read(input,principal){
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='datasetId,executionId'||!reference(input.datasetId)||!reference(input.executionId))fail('EVALUATION_OPTIONS_INVALID_INPUT');
    const request=structuredClone(input),p=structuredClone(principal),ctx={tenantId,actorId:p.id},authority=await access.authorizationRevision(p);
    if(p.tenantId!==tenantId||!p.roles.includes('trainer'))fail('EVALUATION_OPTIONS_FORBIDDEN');
    const epoch=await storage.getReadRevision(ctx),started=(clock??Date.now)();if(!Number.isFinite(started))fail('EVALUATION_OPTIONS_INVALID_CLOCK');
    const history=await compute.listSubmitted(request.datasetId,p),fit=history.items.find(row=>row.id===request.executionId);
    if(history.datasetId!==request.datasetId||!fit||fit.status!=='SUCCEEDED'||typeof fit.recipeHash!=='string'||!/^[a-f0-9]{64}$/.test(fit.recipeHash))fail('EVALUATION_OPTIONS_FIT_NOT_ELIGIBLE');
    const visible=await keys(p),items=[];
    for(const key of visible){const catalog=await protocols.listMetadata(key,p);
      for(const protocol of catalog.items){if(protocol.recipeHash!==fit.recipeHash)continue;
        if(items.length>=100)fail('EVALUATION_OPTIONS_COLLECTION_LIMIT');
        const reasons=[],members=[];
        if(protocol.status!=='APPROVED'||protocol.readiness!=='READY')reasons.push('PROTOCOL_NOT_READY');
        if(!protocol.policyCompatible)reasons.push('PROTOCOL_POLICY_CHANGED');
        if(!reasons.length)for(const cohort of protocol.cohorts){const result=await datasets.frozenMetadata(cohort.id,p),data=result.item;
          if(!data){reasons.push('VALIDATION_NOT_FROZEN');continue;}
          if(data.partition!=='VALIDATION'||data.readiness!=='READY'||!data.cohortCurrent||data.cohort.version!==cohort.version||data.cohort.hash!==cohort.hash
            ||data.classification!==protocol.classification)reasons.push('VALIDATION_NOT_READY');
          members.push({id:data.id,version:data.version,hash:data.contentHash});
        }
        if(members.length!==protocol.cohorts.length&&!reasons.length)reasons.push('VALIDATION_INCOMPLETE');
        if(new Set(members.map(m=>m.id)).size!==members.length)fail('EVALUATION_OPTIONS_INTEGRITY');
        const command={key,protocolId:protocol.id,executionId:request.executionId,validationDatasetIds:members.map(m=>m.id).sort()};
        items.push({optionKey:digest({request,key,protocol:{id:protocol.id,version:protocol.version,hash:protocol.contentHash},members}),key,
          protocol:{id:protocol.id,version:protocol.version,revision:protocol.revision,status:protocol.status,readiness:protocol.readiness,contentHash:protocol.contentHash},
          evaluatorId:protocol.evaluatorId,classification:protocol.classification,recordedAvailable:reasons.length===0,
          unavailableReasons:[...new Set(reasons)],command:reasons.length?null:command,qualification:'NOT_CHECKED'});
      }
    }
    if(await access.authorizationRevision(p)!==authority||digest(await keys(p))!==digest(visible))fail('EVALUATION_OPTIONS_AUTHORITY_STALE');
    if(await storage.getReadRevision(ctx)!==epoch)fail('CONFLICT');const ended=(clock??Date.now)();if(!Number.isFinite(ended)||ended<started)fail('EVALUATION_OPTIONS_INVALID_CLOCK');
    return {schema:'plus-evaluation-submission-options-v1',...request,keys:visible,items,readOnly:true,evaluationAuthorized:false,predictionReady:false,executionAuthorized:false};
  }};
}

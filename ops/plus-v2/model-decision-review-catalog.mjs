import {digest} from '../../platform/packages/plus-contracts/dist/index.js';
import {createPrivateModelDecisionJobAccess} from './model-decision-job-services.mjs';
import {createPrivateModelGovernanceAccess} from './model-governance.mjs';

const fail=code=>{throw Object.assign(Error(code),{code});};
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);

/** Owner-scoped native historical review, not trainer-job discovery or current
 * model admission. The existing native decision worker owns full revalidation. */
export function createPrivateModelDecisionReviewCatalog(options){
  const {storage,tenantId,evaluations,protocols,recipes,resultKeys,authorizeEvaluation,clock}=options;
  const jobs=createPrivateModelDecisionJobAccess(options),governance=createPrivateModelGovernanceAccess(options);
  if(typeof storage?.getReadRevision!=='function'||typeof evaluations?.readRecorded!=='function'||typeof protocols?.readMetadata!=='function'
    ||typeof recipes?.readMetadata!=='function'||typeof resultKeys!=='function'||typeof authorizeEvaluation!=='function')fail('MODEL_REVIEW_PROVIDER_REQUIRED');
  async function scopes(p){const items=[];
    for(const key of await jobs.submissionKeys(p))if(await governance.authorize(p,'model:decide',key))items.push({key,policy:await governance.policyFor(p,key)});
    return items;
  }
  async function keys(p){const items=[];for(const key of await resultKeys(p))if(await authorizeEvaluation(p,'evaluation:read',key))items.push(key);return items;}
  return {async read(principal){
    const p=structuredClone(principal),authority=await jobs.authorizationRevision(p),ctx={tenantId,actorId:p.id};
    if(p.tenantId!==tenantId||!p.roles.includes('model_owner'))fail('MODEL_REVIEW_FORBIDDEN');
    const epoch=await storage.getReadRevision(ctx),started=(clock??Date.now)();if(!Number.isFinite(started))fail('MODEL_REVIEW_INVALID_CLOCK');
    const targets=await scopes(p),visible=targets.length?await keys(p):[],items=[];
    let count=0;
    for(const key of visible){
      const page=await storage.queryObjects(ctx,'PlusModelEvaluation',{field:'protocolKey',operator:'eq',value:key},{limit:101});
      count+=page.items.length;
      if(page.hasNextPage||page.totalCount!==page.items.length||count>100||new Set(page.items.map(r=>r._id)).size!==page.items.length)fail('MODEL_REVIEW_COLLECTION_LIMIT');
      for(const row of page.items){
        if(row._type!=='PlusModelEvaluation'||row._tenantId!==tenantId||row._deletedAt||row.protocolKey!==key)fail('MODEL_REVIEW_INTEGRITY');
        const recorded=await evaluations.readRecorded(row._id,p),score=recorded.item;
        if(recorded.qualification!=='NOT_CHECKED'||score.id!==row._id||score.version!==row._version||score.protocolKey!==key)fail('MODEL_REVIEW_INTEGRITY');
        const nativeRecipe=await storage.getObject(ctx,'PlusModelRecipe',score.evidence.recipe.id);
        if(!nativeRecipe||nativeRecipe._type!=='PlusModelRecipe'||nativeRecipe._tenantId!==tenantId||nativeRecipe._deletedAt)fail('MODEL_REVIEW_RECIPE_MISSING');
        const recipe=(await recipes.readMetadata(nativeRecipe.recipeKey,nativeRecipe._id,p)).item;
        const protocol=(await protocols.readMetadata(score.evidence.protocol.id,p)).item;
        if(protocol.key!==key||protocol.evaluatorId!==score.evaluatorId||protocol.recipe.id!==recipe.id||!hash(recipe.recipeHash))fail('MODEL_REVIEW_INTEGRITY');
        for(const {key:targetKey,policy} of targets){
          const component=policy.version==='plus-transition-component-admission-v1';
          const clockHash=component?recipe.component?.timeContractHash:protocol.configuration.clock?digest(protocol.configuration.clock):null;
          if(policy.definitionHash!==recipe.definitionHash||policy.bindingHash!==recipe.bindingHash||policy.scopeKey!==recipe.scopeKey
            ||policy.classification!==recipe.classification||score.classification!==policy.classification||score.result.task!==policy.task
            ||clockHash!==policy.clockHash||component&&digest(recipe.component)!==digest(policy.component))continue;
          const reasons=[];
          if(score.readiness!=='READY')reasons.push('EVALUATION_NOT_READY');
          if(protocol.status!=='APPROVED'||protocol.readiness!=='READY'||protocol.version!==score.evidence.protocol.version||protocol.contentHash!==score.evidence.protocol.hash)reasons.push('PROTOCOL_CHANGED');
          if(recipe.status!=='APPROVED'||recipe.version!==score.evidence.recipe.version||recipe.recipeHash!==score.evidence.recipe.hash
            ||protocol.recipe.version!==recipe.version||protocol.recipe.hash!==recipe.recipeHash)reasons.push('RECIPE_CHANGED');
          if(score.createdBy===p.id)reasons.push('INDEPENDENT_REVIEW_REQUIRED');
          const approvalReasons=[...reasons];if(score.result.decision!=='ELIGIBLE_FOR_REVIEW')approvalReasons.push(score.result.decision);
          if(items.length>=100)fail('MODEL_REVIEW_COLLECTION_LIMIT');
          items.push({optionKey:digest({targetKey,policy,score:{id:score.id,version:score.version,hash:score.contentHash}}),key:targetKey,
            scope:{definitionHash:policy.definitionHash,bindingHash:policy.bindingHash,scopeKey:policy.scopeKey,classification:policy.classification,task:policy.task,
              modelKind:component?'TRANSITION_COMPONENT':'COMPLETE_MODEL'},score,recipe,protocol,qualification:'NOT_CHECKED',
            unavailableReasons:reasons,approvalUnavailableReasons:approvalReasons,
            command:reasons.length?null:{key:targetKey,evaluationId:score.id,evaluationVersion:score.version}});
        }
      }
    }
    if(await jobs.authorizationRevision(p)!==authority||digest(await scopes(p))!==digest(targets)
      ||digest(targets.length?await keys(p):[])!==digest(visible))fail('MODEL_REVIEW_AUTHORITY_STALE');
    if(await storage.getReadRevision(ctx)!==epoch)fail('CONFLICT');const ended=(clock??Date.now)();if(!Number.isFinite(ended)||ended<started)fail('MODEL_REVIEW_INVALID_CLOCK');
    return {schema:'plus-model-decision-review-v1',keys:targets.map(t=>t.key),items,readOnly:true,qualification:'NOT_CHECKED',predictionReady:false,executionAuthorized:false};
  }};
}

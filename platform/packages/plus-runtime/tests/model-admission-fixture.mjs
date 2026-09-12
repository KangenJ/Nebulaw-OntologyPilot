import assert from 'node:assert/strict';
import { digest } from '@openfoundry/plus-contracts';
import { NativeModelDecision } from '../dist/index.js';
import { episodeFixture,ctx,at } from './episode-fixture.mjs';
export {ctx,at};
export const admissionOwner={id:'independent-owner',tenantId:ctx.tenantId,roles:['model_owner']};

// Governance-unit fixture: native SQLite and a published definition, with explicit
// evaluator/recipe doubles. Not a real fitted-model or business-efficacy claim.
export async function modelAdmissionFixture(t,{regression=false}={}){
  const f=await episodeFixture(t),published=await f.definitions.requirePublished(f.definition.key,admissionOwner),compiled=published.compiled;
  const definitionHash=compiled.definitionHash,bindingHash=digest('binding'),clock={schema:'plus-fixed-step-clock-v1',definitionHash,bindingHash,stepMilliseconds:60000,maxSteps:16,transitionContext:'INTERVAL_START',interventions:'WAIT_ONLY'};
  const payload={compiled,config:{bindingHash}},recipeHash=digest(payload);
  const recipe=await f.storage.createObject(ctx,'PlusModelRecipe',{revisionKey:'unit-recipe',recipeKey:'unit.recipe',revision:1,definitionKey:f.definition.key,definitionHash,
    definitionReference:{id:published.record._id,version:published.record._version,compiledHash:digest(compiled)},engineId:'unit-double',recipeHash,payload,policyHash:digest('policy'),submittedBy:'recipe-author',submittedAt:at(0),proposalHash:digest('unit-not-real-recipe'),status:'APPROVED'});
  const protocol=await f.storage.createObject(ctx,'PlusEvaluationProtocol',{revisionKey:'unit-protocol',protocolKey:'unit.protocol',revision:1,evaluatorId:'unit-double',payload:{configuration:{clock}},contentHash:digest('unit-protocol'),proposedBy:'trainer',proposedAt:at(0),status:'APPROVED',readiness:'READY'});
  const evaluations=new Map();
  async function candidate(suffix,regression=false){
    const release=await f.storage.createObject(ctx,'PlusModelRelease',{releaseKey:'unit-release-'+suffix,estimatorId:'unit-double',updateKind:'U2',classification:'SYNTHETIC',artifactHash:digest('unit-artifact-'+suffix),artifactKey:'unit-artifact-'+suffix,consumedSources:[],evaluation:{status:'NOT_EVALUATED'},dependencyHash:definitionHash,status:'CANDIDATE',createdBy:'trainer'});
    const evaluation=await f.storage.createObject(ctx,'PlusModelEvaluation',{evaluationKey:'unit-evaluation-'+suffix,protocolKey:'unit.protocol',evaluatorId:'unit-double',classification:'SYNTHETIC',inputReadSet:{recipe:{id:recipe._id,version:recipe._version,hash:recipeHash},protocol:{id:protocol._id},candidateId:release._id},
      result:{task:'STATE_ESTIMATION',classification:'SYNTHETIC',decision:regression?'REJECT_REGRESSION':'ELIGIBLE_FOR_REVIEW'},contentHash:digest('unit-evaluation-'+suffix),createdBy:'scorer',createdAt:at(1),readiness:'READY'});
    evaluations.set(evaluation._id,evaluation);return {release,evaluation};
  }
  const {release,evaluation}=await candidate('initial',regression);
  const policy={version:'plus-model-admission-v1',id:'unit-admission',definitionHash,bindingHash,scopeKey:compiled.definition.scope.key,classification:'SYNTHETIC',task:'STATE_ESTIMATION',clockHash:digest(clock)};
  const state={epoch:1,allow:true,readCalls:[],beforeRead:async()=>{}};
  const config={storage:f.storage,tenantId:ctx.tenantId,evaluations:{read:async(id,p,options)=>{state.readCalls.push(options.recompute);await state.beforeRead(id,p,options);assert.ok(evaluations.has(id));return {record:structuredClone(evaluations.get(id)),modelDeploymentAuthorized:false};}},
    recipes:{requireApproved:async h=>{assert.equal(h,recipeHash);return {record:structuredClone(recipe),payload:structuredClone(payload)};}},
    authorize:async()=>state.allow,policyFor:async()=>structuredClone(policy),authorizationRevision:async()=>digest({policy,epoch:state.epoch}),clock:()=>Date.parse(at(2))};
  const input={key:'unit.admission',evaluationId:evaluation._id,evaluationVersion:evaluation._version,decision:'APPROVE',reason:'unit governance only'};
  return {...f,config,state,policy,input,recipe,release,evaluation,candidate,rows:()=>f.storage.queryObjects(ctx,'PlusModelDecision',{and:[]}),decisions:new NativeModelDecision(config)};
}

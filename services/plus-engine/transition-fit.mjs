// Real finite transition counts on structurally checked longitudinal evidence.
// Native enrollment/source/interval authority belongs to the platform. Self-hashed
// material is not proof of authority; no FIT HTTP/online registry is enabled here.
import { canonicalJson as key,digest,recompileTransitionSupervision,validateTransitionPair,validateTransitionTimeContract,validateTransitionActionHistoryContract } from '../../platform/packages/plus-contracts/dist/index.js';
import { EngineError } from './finite-engine.mjs';
import { qualifyCompleteTransitionMaterial } from './transition-material.mjs';
export const transitionEstimatorId='ontology-finite-transition-counts-v1';
const check=(v,code)=>{if(!v)throw new EngineError(code);};
const same=(a,b)=>key(a)===key(b);
const fields=(v,n)=>check(v&&Object.getPrototypeOf(v)===Object.prototype&&same(Object.keys(v).sort(),[...n].sort()),'TRANSITION_FIT_ENVELOPE');
const hash=v=>check(typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),'TRANSITION_FIT_HASH');
const count=(v,min,max)=>check(Number.isSafeInteger(v)&&v>=min&&v<=max,'TRANSITION_FIT_BUDGET');
const text=v=>check(typeof v==='string'&&v.trim().length>0&&v.length<=2000,'TRANSITION_FIT_IDENTIFIER');
const instant=v=>{check(typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v,'TRANSITION_FIT_TIME');return Date.parse(v);};
const ordered=values=>[...values].sort((a,b)=>key(a)<key(b)?-1:key(a)>key(b)?1:0);
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};

export function validateTransitionRecipe(recipe,compiled){
  const actionBound=recipe?.schema==='plus-transition-recipe-v3',timed=actionBound||recipe?.schema==='plus-transition-recipe-v2';
  fields(recipe,['schema','engineId','compiled','supervision','config',...(timed?['timeContract']:[]),...(actionBound?['actionHistoryContract']:[])]);
  check(['plus-transition-recipe-v1','plus-transition-recipe-v2','plus-transition-recipe-v3'].includes(recipe.schema)&&recipe.engineId===transitionEstimatorId&&same(recipe.compiled,compiled),'TRANSITION_FIT_RECIPE');
  const supervision=recompileTransitionSupervision(recipe.supervision,compiled),config=recipe.config,s=supervision.specification;
  if(timed)validateTransitionTimeContract(recipe.timeContract,supervision,compiled);
  if(actionBound)validateTransitionActionHistoryContract(recipe.actionHistoryContract,compiled);
  fields(config,['classification','collectionPolicyHash','populationPolicyHash','trainingProtocolHashes','smoothingAlpha','minimumPairs','minimumTrajectories','minimumGroups','minimumPerCondition','minimumCoverage']);
  for(const k of ['classification','collectionPolicyHash','populationPolicyHash'])check(config[k]===s[k],'TRANSITION_FIT_CONTRACT');
  check(Array.isArray(config.trainingProtocolHashes)&&config.trainingProtocolHashes.length>0&&config.trainingProtocolHashes.length<=10
    &&new Set(config.trainingProtocolHashes).size===config.trainingProtocolHashes.length,'TRANSITION_FIT_PROTOCOLS');config.trainingProtocolHashes.forEach(hash);
  check(Number.isFinite(config.smoothingAlpha)&&config.smoothingAlpha>=1e-6&&config.smoothingAlpha<=1e6,'TRANSITION_FIT_SMOOTHING');
  count(config.minimumPairs,1,s.budget.maxPairs);count(config.minimumTrajectories,1,s.budget.maxTrajectories);
  count(config.minimumGroups,1,config.minimumTrajectories);count(config.minimumPerCondition,1,s.budget.maxPairs);
  check(Number.isFinite(config.minimumCoverage)&&config.minimumCoverage>=0&&config.minimumCoverage<=1,'TRANSITION_FIT_COVERAGE');
  return supervision;
}
export function transitionRecipe(compiled,supervision,config,timeContract,actionHistoryContract){
  const recipe=structuredClone({schema:actionHistoryContract!==undefined?'plus-transition-recipe-v3':timeContract===undefined?'plus-transition-recipe-v1':'plus-transition-recipe-v2',engineId:transitionEstimatorId,compiled,supervision,config,
    ...(timeContract===undefined?{}:{timeContract}),...(actionHistoryContract===undefined?{}:{actionHistoryContract})});
  validateTransitionRecipe(recipe,compiled);return {recipe,recipeHash:digest(recipe)};
}
export const transitionPairKey=(supervisionHash,root,fromTime,toTime)=>digest([supervisionHash,root.tenantId,root.type,root.id,fromTime,toTime]);

/** Each material must include every pre-enrolled interval, with explicit null for
 * missing GOLD. Invalid evidence is a hard failure, not an exclusion opportunity.
 * The native assembler must prove this is the ORIGINAL prospective enrollment;
 * this pure function cannot establish approval authenticity from JSON alone.
 */
export function fitTransitionModel(recipe,materials){
  const supervision=validateTransitionRecipe(recipe,recipe?.compiled),s=supervision.specification,c=recipe.config;
  check(Array.isArray(materials)&&materials.length>0&&materials.length<=10,'TRANSITION_FIT_MATERIAL_BUDGET');
  if(['plus-native-action-interval-policy-v2','plus-native-action-interval-policy-v3'].includes(recipe.actionHistoryContract?.version))check(materials.length===1&&materials[0]?.schema==='plus-transition-fit-material-v2','TRANSITION_FIT_COMPLETE_PLAN_REQUIRED');
  if(materials.some(m=>m?.schema==='plus-transition-fit-material-v2')){
    // v2 is one complete approved protocol-set plan, not independently selected
    // per-cohort fragments. Additional rounds are assembled into that full plan.
    check(materials.length===1,'TRANSITION_FIT_COMPLETE_PLAN_REQUIRED');
    const qualified=qualifyCompleteTransitionMaterial(recipe,materials[0],supervision),state={pairs:[],missing:[],plans:new Set(),entities:new Set(),groups:new Set(),
      families:new Set(qualified.sourceFamilyKeys),refs:new Map(qualified.referenceEvidence.map(r=>[key([r.hashKind,r.type,r.id,r.version]),r])),
      entityGroups:new Map(),materialHashes:new Set([materials[0].contentHash])};
    for(const row of qualified.rows){state.plans.add(row.pairKey);state.entityGroups.set(row.entityKey,row.groupHash);
      if(row.status==='MISSING_GOLD')state.missing.push({pairKey:row.pairKey,entityKey:row.entityKey,groupHash:row.groupHash,reason:'MISSING_GOLD',missingSampleKeys:row.missingSampleKeys});
      else{state.pairs.push(row);state.entities.add(row.entityKey);state.groups.add(row.groupHash);}}
    return finishTransitionFit(recipe,supervision,state,{sourcePlanHash:qualified.planHash,cohortIds:qualified.cohortIds,datasetIds:qualified.datasetIds,
      nativeReadSet:qualified.nativeReadSet,materialSchema:'plus-transition-fit-material-v2'});
  }
  const pairs=[],missing=[],plans=new Set(),entities=new Set(),groups=new Set(),families=new Set(),refs=new Map(),endpoints=new Map(),entityGroups=new Map(),familyGroups=new Map(),materialHashes=new Set();
  const addRef=r=>{const prior=refs.get(r.id);check(!prior||same(prior,r),'TRANSITION_FIT_REFERENCE_CONFLICT');refs.set(r.id,r);check(refs.size<=20000,'TRANSITION_FIT_MATERIAL_BUDGET');};
  for(const m of ordered(materials)){
    check(key(m).length<=8*1024*1024,'TRANSITION_FIT_MATERIAL_BUDGET');
    fields(m,['schema','supervisionHash','classification','purpose','protocolHash','enrollment','samples','contentHash']);
    check(m.schema==='plus-transition-fit-material-v1'&&m.supervisionHash===supervision.contentHash&&m.classification===c.classification,'TRANSITION_FIT_MATERIAL_CONTRACT');
    check(m.purpose==='FIT','TRANSITION_FIT_PURPOSE');check(c.trainingProtocolHashes.includes(m.protocolHash),'TRANSITION_FIT_UNAPPROVED_PROTOCOL');
    check(m.contentHash===digest(Object.fromEntries(Object.entries(m).filter(([k])=>k!=='contentHash'))),'TRANSITION_FIT_MATERIAL_INTEGRITY');
    check(!materialHashes.has(m.contentHash),'TRANSITION_FIT_DUPLICATE_MATERIAL');materialHashes.add(m.contentHash);
    const e=m.enrollment;fields(e,['reference','approvedAt','proposedBy','approvedBy','plannedPairs']);fields(e.reference,['id','version','hash']);
    text(e.reference.id);hash(e.reference.hash);count(e.reference.version,1,Number.MAX_SAFE_INTEGER);instant(e.approvedAt);text(e.proposedBy);text(e.approvedBy);
    check(e.proposedBy!==e.approvedBy,'TRANSITION_FIT_SELF_ENROLLMENT');addRef(e.reference);
    check(Array.isArray(e.plannedPairs)&&e.plannedPairs.length>0&&e.plannedPairs.length<=s.budget.maxPairs
      &&Array.isArray(m.samples)&&m.samples.length===e.plannedPairs.length,'TRANSITION_FIT_ENROLLMENT');
    const samples=new Map();
    for(const sample of m.samples){fields(sample,['pairKey','evidence']);hash(sample.pairKey);check(!samples.has(sample.pairKey),'TRANSITION_FIT_DUPLICATE_PAIR');samples.set(sample.pairKey,sample.evidence);}
    for(const plan of ordered(e.plannedPairs)){
      fields(plan,['pairKey','root','startedAt','fromTime','toTime','groupHash','inputSourceFamilyKeys','inputReferences']);fields(plan.root,['tenantId','type','id']);Object.values(plan.root).forEach(text);hash(plan.groupHash);
      const from=instant(plan.fromTime),to=instant(plan.toTime),start=instant(plan.startedAt);
      check(plan.root.type===recipe.compiled.definition.rootType&&start<=from&&(from-start)%s.stepMs===0&&to-from===s.stepMs
        &&plan.pairKey===transitionPairKey(supervision.contentHash,plan.root,plan.fromTime,plan.toTime),'TRANSITION_FIT_ENROLLMENT');
      if(recipe.schema!=='plus-transition-recipe-v1')check((to-start)/s.stepMs<=recipe.timeContract.maxSteps,'TRANSITION_FIT_TIME_BUDGET');
      check(!plans.has(plan.pairKey)&&samples.has(plan.pairKey),'TRANSITION_FIT_DUPLICATE_PAIR');plans.add(plan.pairKey);count(plans.size,1,s.budget.maxPairs);
      const entity=digest([plan.root.tenantId,plan.root.type,plan.root.id]),priorGroup=entityGroups.get(entity);
      check(!priorGroup||priorGroup===plan.groupHash,'TRANSITION_FIT_TRAJECTORY_SPLIT');entityGroups.set(entity,plan.groupHash);
      check(Array.isArray(plan.inputReferences)&&plan.inputReferences.length===2&&plan.inputReferences[0].id!==plan.inputReferences[1].id,'TRANSITION_FIT_INPUT_PROVENANCE');
      for(const ref of plan.inputReferences){fields(ref,['id','version','hash']);text(ref.id);count(ref.version,1,Number.MAX_SAFE_INTEGER);hash(ref.hash);addRef(ref);}
      // Only sources already exposed in prelabel INPUT belong in enrollment.
      // Later GOLD families are added from the actual qualified pair below.
      check(Array.isArray(plan.inputSourceFamilyKeys)&&plan.inputSourceFamilyKeys.length<=2000&&new Set(plan.inputSourceFamilyKeys).size===plan.inputSourceFamilyKeys.length,'TRANSITION_FIT_SOURCE_PROVENANCE');
      for(const family of plan.inputSourceFamilyKeys){text(family);const prior=familyGroups.get(family);check(!prior||prior===plan.groupHash,'TRANSITION_FIT_SOURCE_GROUP_SPLIT');familyGroups.set(family,plan.groupHash);families.add(family);}
      check(families.size<=10000,'TRANSITION_FIT_MATERIAL_BUDGET');
      const evidence=samples.get(plan.pairKey);
      if(evidence===null){missing.push({pairKey:plan.pairKey,entityKey:entity,groupHash:plan.groupHash,reason:'MISSING_GOLD'});continue;}
      const row=validateTransitionPair(evidence,supervision,recipe.compiled);
      check(row.partition==='TRAIN'&&row.entityKey===entity&&row.groupHash===plan.groupHash&&row.fromTime===plan.fromTime&&row.toTime===plan.toTime,
        'TRANSITION_FIT_PAIR_PLAN');
      check(evidence.from.startedAt===plan.startedAt&&evidence.to.startedAt===plan.startedAt
        &&same(plan.inputReferences,[evidence.from.input,evidence.to.input]),
        'TRANSITION_FIT_INPUT_PROVENANCE');
      check(same(evidence.enrollment,{...e.reference,approvedAt:e.approvedAt,proposedBy:e.proposedBy,approvedBy:e.approvedBy}),'TRANSITION_FIT_PAIR_ENROLLMENT');
      for(const endpoint of [evidence.from,evidence.to]){
        const endpointKey=key([entity,endpoint.targetTime]);
        // Adjacent pairs may share a middle endpoint; its actual snapshot and
        // GOLD lineage must be identical, not counted as independent re-labeling.
        const prior=endpoints.get(endpointKey);check(!prior||same(prior,endpoint),'TRANSITION_FIT_ENDPOINT_CONFLICT');endpoints.set(endpointKey,endpoint);
      }
      for(const family of row.sourceFamilyKeys){const prior=familyGroups.get(family);check(!prior||prior===row.groupHash,'TRANSITION_FIT_SOURCE_GROUP_SPLIT');familyGroups.set(family,row.groupHash);families.add(family);}
      check(families.size<=10000,'TRANSITION_FIT_MATERIAL_BUDGET');
      row.references.forEach(addRef);entities.add(entity);groups.add(row.groupHash);pairs.push({...row,pairKey:plan.pairKey});
    }
  }
  return finishTransitionFit(recipe,supervision,{pairs,missing,plans,entities,groups,families,refs,entityGroups,materialHashes});
}

// One numerical estimator for legacy structural evidence and complete native
// plans. Different evidence envelopes do not introduce a second fitting model.
function finishTransitionFit(recipe,supervision,state,provenance){
  const {pairs,missing,plans,entities,groups,families,refs,entityGroups,materialHashes}=state,s=supervision.specification,c=recipe.config;
  count(entityGroups.size,1,s.budget.maxTrajectories);
  const coverage={enrolled:plans.size,eligible:pairs.length,missing:missing.length,fraction:pairs.length/plans.size};
  check(pairs.length>=c.minimumPairs&&entities.size>=c.minimumTrajectories&&groups.size>=c.minimumGroups&&coverage.fraction>=c.minimumCoverage,'TRANSITION_FIT_INSUFFICIENT_DATA');
  const condition=(control,from,context)=>({control,from:Object.fromEntries(supervision.layout.latentInputs.map(k=>[k,from[k]])),context});
  const rows=new Map();
  for(const control of [...new Set(Object.values(supervision.layout.parameterControl))].sort())
    for(const from of supervision.layout.states)for(const context of supervision.layout.contexts){
      const value=condition(control,from,context),id=key(value);
      if(!rows.has(id))rows.set(id,{condition:value,counts:supervision.layout.states.map(()=>0),entities:new Set(),groups:new Set()});
    }
  for(const pair of pairs){
    const row=rows.get(key(condition(pair.parameterControl,pair.from,pair.context))),index=supervision.layout.states.findIndex(s=>same(s,pair.to));
    check(row&&index>=0,'TRANSITION_FIT_LAYOUT');row.counts[index]++;row.entities.add(pair.entityKey);row.groups.add(pair.groupHash);
  }
  const table=ordered([...rows.values()].map(row=>{
    const observations=row.counts.reduce((a,b)=>a+b,0),supported=observations>=c.minimumPerCondition;
    return {condition:row.condition,observations,trajectoryCount:row.entities.size,groupCount:row.groups.size,status:supported?'LEARNED':'UNSUPPORTED',
      counts:row.counts,probabilities:supported?row.counts.map(n=>(n+c.smoothingAlpha)/(observations+c.smoothingAlpha*row.counts.length)):null};
  }));
  const body={schema:provenance?'plus-transition-fit-result-v2':'plus-transition-fit-result-v1',recipeHash:digest(recipe),supervisionHash:supervision.contentHash,classification:c.classification,
    updateKind:'FINITE_TRANSITION_COUNTS',layout:structuredClone(supervision.layout),table,coverage,
    consumption:{materials:[...materialHashes].sort(),pairKeys:pairs.map(p=>p.pairKey).sort(),plannedPairKeys:[...plans].sort(),
      entityKeys:[...entityGroups.keys()].sort(),groupHashes:[...new Set(entityGroups.values())].sort(),eligibleEntityKeys:[...entities].sort(),eligibleGroupHashes:[...groups].sort(),
      sourceFamilyKeys:[...families].sort(),references:ordered([...refs.values()]),missing:ordered(missing),...(provenance?{provenance}: {})},
    semantics:'OBSERVED_CONDITIONAL_TRANSITION_NOT_CAUSAL_EFFECT',neuralTrained:false,trainingAuthorized:false,predictionReady:false};
  return freeze({...body,artifactHash:digest(body)});
}
export function verifyTransitionFit(recipe,materials,candidate){const actual=fitTransitionModel(recipe,materials);check(same(actual,candidate),'TRANSITION_FIT_RECOMPUTE_MISMATCH');return actual;}

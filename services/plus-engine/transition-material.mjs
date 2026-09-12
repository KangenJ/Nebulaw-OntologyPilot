// Complete native-plan computation contract. This is a PURE structural checker:
// callers can fabricate JSON and hashes. Native assembly/completion, not these
// flags or digests, establishes current authority. No private FIT registration.
import { canonicalJson as key,digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { EngineError } from './finite-engine.mjs';
import { actionIntervalDependencies } from '../../platform/packages/plus-runtime/dist/action-interval-dependencies.js';
const check=(v,code='TRANSITION_MATERIAL_CONTRACT')=>{if(!v)throw new EngineError(code);};
const same=(a,b)=>key(a)===key(b);
const object=v=>{check(v&&typeof v==='object'&&!Array.isArray(v),'TRANSITION_MATERIAL_SHAPE');return v;};
const hash=v=>check(typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),'TRANSITION_MATERIAL_HASH');
const text=v=>check(typeof v==='string'&&v.trim()&&v.length<=2000,'TRANSITION_MATERIAL_IDENTIFIER');
const time=v=>{check(typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v,'TRANSITION_MATERIAL_TIME');return Date.parse(v);};
const list=(v,min,max)=>check(Array.isArray(v)&&v.length>=min&&v.length<=max,'TRANSITION_MATERIAL_BUDGET');
const shape=(v,n)=>check(v&&same(Object.keys(v).sort(),[...n].sort()),'TRANSITION_MATERIAL_SHAPE');
const signed=v=>{const {contentHash,...body}=object(v);hash(contentHash);check(digest(body)===contentHash,'TRANSITION_MATERIAL_INTEGRITY');};
const mapBy=(items,k)=>{const m=new Map();for(const item of items){const id=k(item);check(!m.has(id),'TRANSITION_MATERIAL_DUPLICATE');m.set(id,item);}return m;};

export function qualifyCompleteTransitionMaterial(recipe,material,supervision){
  return qualifyTransitionPlan(recipe,material,supervision);
}

/** Still pure structural checking, not proof that the supplied protocol/rows
 * were loaded from current native authority. No conversion to TRAIN is allowed. */
export function qualifyCompleteTransitionValidationMaterial(recipe,material,supervision,protocol){
  object(protocol);const payload=object(protocol.payload),decision=object(protocol.decision);
  check(protocol._type==='PlusEvaluationProtocol'&&protocol.status==='APPROVED'&&protocol.readiness==='READY'
    &&protocol.evaluatorId==='ontology-conditional-transition-validation-v1'&&decision.decision==='APPROVE'
    &&decision.actorId!==protocol.proposedBy,'TRANSITION_VALIDATION_PROTOCOL');
  const fingerprint=digest(Object.fromEntries(['revisionKey','protocolKey','revision','evaluatorId','payload','proposedBy','proposedAt'].map(k=>[k,protocol[k]])));
  check(fingerprint===protocol.contentHash&&protocol.decisionHash===digest({contentHash:protocol.contentHash,decision}),'TRANSITION_VALIDATION_PROTOCOL_INTEGRITY');
  check(time(decision.at)>=time(protocol.proposedAt)&&payload.recipe.hash===digest(recipe),'TRANSITION_VALIDATION_PROTOCOL');
  list(payload.cohorts,1,10);check(new Set(payload.cohorts.map(c=>c.id)).size===payload.cohorts.length,'TRANSITION_VALIDATION_PROTOCOL');
  const validation=material?.sourcePlan?.contextPlan?.plan?.validation;object(validation);
  check(validation.purpose==='VALIDATE'&&validation.protocolHash===protocol.contentHash&&validation.protocol.id===protocol._id
    &&validation.protocol.type===protocol._type&&validation.protocol.version===protocol._version&&validation.protocol.hash===digest(protocol)
    &&same(validation.configuration,payload.configuration)&&same(validation.membership,payload.transitionMembership),'TRANSITION_VALIDATION_PROTOCOL_BINDING');
  const membership=object(payload.transitionMembership);signed(membership);
  check(membership.recipeHash===digest(recipe)&&membership.configurationHash===digest(payload.configuration)&&membership.supervisionHash===supervision.contentHash
    &&membership.evaluatorId===protocol.evaluatorId&&membership.scoringReady===false&&membership.predictionReady===false&&membership.modelDeploymentAuthorized===false,'TRANSITION_VALIDATION_MEMBERSHIP');
  const result=qualifyTransitionPlan(recipe,material,supervision,protocol),p=material.sourcePlan.contextPlan.plan;
  check(payload.recipe.id===p.recipe.id&&payload.recipe.version===p.recipe.version&&payload.recipe.definitionHash===recipe.compiled.definitionHash
    &&payload.recipe.classification===recipe.config.classification,'TRANSITION_VALIDATION_RECIPE_BINDING');
  check(same(p.datasets.map(d=>d.enrollment.reference.id).sort(),payload.cohorts.map(c=>c.id).sort()),'TRANSITION_VALIDATION_COHORT_SET');
  for(const d of p.datasets){const c=payload.cohorts.find(c=>c.id===d.enrollment.reference.id);
    check(c.version===d.enrollment.reference.version&&same(c.protocol,d.protocol)&&time(decision.at)<time(d.protocol.labelReceivedFrom),'TRANSITION_VALIDATION_COHORT_BINDING');}
  check(same(membership.coverage,{enrolledEndpoints:p.coverage.enrolledEndpoints,trajectories:p.coverage.trajectories,plannedPairs:p.coverage.plannedPairs,
    groups:new Set(result.rows.map(r=>r.groupHash)).size}),'TRANSITION_VALIDATION_MEMBERSHIP');
  return result;
}

function qualifyTransitionPlan(recipe,material,supervision,protocol){
  const validation=protocol!==undefined,partition=validation?'VALIDATION':'TRAIN';
  check(recipe.schema==='plus-transition-recipe-v3','TRANSITION_MATERIAL_APPROVED_HISTORY_REQUIRED');
  shape(material,validation?['schema','purpose','recipeHash','protocolId','sourcePlan','scoringReady','trainingAuthorized','predictionReady','contentHash']:['schema','purpose','recipeHash','sourcePlan','contentHash']);signed(material);
  check(material.schema===(validation?'plus-transition-validation-material-v1':'plus-transition-fit-material-v2')&&material.purpose===(validation?'VALIDATE':'FIT')&&material.recipeHash===digest(recipe));
  if(validation)check(material.protocolId===protocol._id&&material.scoringReady===false&&material.trainingAuthorized===false&&material.predictionReady===false,'TRANSITION_VALIDATION_PURPOSE');
  check(Buffer.byteLength(key(material))<=24*1024*1024,'TRANSITION_MATERIAL_BUDGET');
  const outer=object(material.sourcePlan),cp=object(outer.contextPlan),p=object(cp.plan),s=supervision.specification,c=recipe.compiled;
  signed(outer);signed(cp);signed(p);
  check(Object.hasOwn(p,'validation')===validation,'TRANSITION_MATERIAL_PURPOSE');
  check(outer.schema==='plus-native-transition-action-plan-v1'&&outer.recipeHistoryBindingChecked===true&&outer.nativeReadQualificationsChecked===true
    &&cp.schema==='plus-native-transition-context-plan-v1'&&cp.historicalContextChecked===true&&cp.nativeTimeContractChecked===true
    &&p.schema==='plus-native-transition-plan-v1'&&p.nativeMembershipChecked===true&&p.nativeTimeContractChecked===true
    &&p.recipeHash===material.recipeHash&&p.supervisionHash===supervision.contentHash
    &&same(p.timeContract,recipe.timeContract)&&same(p.actionHistoryContract,recipe.actionHistoryContract));
  text(p.tenantId);hash(p.readSet.authorizationRevision);hash(p.endpointMaterialHash);
  const approvals=r=>{text(r.proposedBy);text(r.approvedBy);check(r.proposedBy!==r.approvedBy,'TRANSITION_MATERIAL_SELF_APPROVAL');return time(r.approvedAt);};
  const recipeApproved=approvals(p.recipeApproval),refs=new Map();
  // Historical versions are legitimate. A context projection is NOT a hash of
  // the full native row; preserve its hash kind rather than conflating the two.
  const addRef=(r,hashKind='RECORD')=>{text(r.type);text(r.id);hash(r.hash);check(Number.isSafeInteger(r.version)&&r.version>0);
    const id=key([hashKind,r.type,r.id,r.version]),v={type:r.type,id:r.id,version:r.version,hash:r.hash,hashKind};
    check(!refs.has(id)||same(refs.get(id),v),'TRANSITION_MATERIAL_REFERENCE_CONFLICT');refs.set(id,v);
    check(refs.size<=20000,'TRANSITION_MATERIAL_BUDGET');return v;};
  check(p.recipe.type==='PlusModelRecipe');addRef(p.recipe);list(p.datasets,1,10);list(p.pairs,1,s.budget.maxPairs);
  const datasets=mapBy(p.datasets,d=>d.enrollment.reference.id),declaredMembers=new Set(),actualMembers=new Set();
  const protocolHashes=validation?protocol.payload.cohorts.map(c=>digest(c.protocol)):recipe.config.trainingProtocolHashes;
  check(same(p.datasets.map(d=>d.protocolHash).sort(),[...protocolHashes].sort()),'TRANSITION_MATERIAL_PROTOCOL_SET');
  for(const d of p.datasets){addRef(d.reference);addRef(d.enrollment.reference);const enrolled=approvals(d.enrollment),q=d.protocol;
    check(d.reference.type==='PlusDatasetRevision'&&d.enrollment.reference.type==='PlusCohort'&&q.version==='plus-cohort-v1'&&digest(q)===d.protocolHash
      &&q.definitionHash===c.definitionHash&&q.collectionPolicyHash===s.collectionPolicyHash&&q.classification===s.classification&&q.partition===partition
      &&supervision.layout.stateVariables.includes(q.variable),'TRANSITION_MATERIAL_PROTOCOL');
    check(time(q.inputVisibleFrom)<=time(q.inputVisibleUntil)&&time(q.inputVisibleUntil)<time(q.labelReceivedFrom)
      &&time(q.labelReceivedFrom)<time(q.labelReceivedUntil)&&time(q.labelReceivedUntil)<=time(q.approvalUntil)
      &&recipeApproved<time(q.labelReceivedFrom)&&enrolled<time(q.labelReceivedFrom),'TRANSITION_MATERIAL_PROSPECTIVE');
    list(d.sampleKeys,1,1000);check(d.sampleKeys.length===q.expectedSampleCount&&new Set(d.sampleKeys).size===d.sampleKeys.length,'TRANSITION_MATERIAL_MEMBERSHIP');
    for(const k of d.sampleKeys){hash(k);check(!declaredMembers.has(k),'TRANSITION_MATERIAL_MEMBERSHIP');declaredMembers.add(k);}
  }
  list(cp.pairs,p.pairs.length,p.pairs.length);list(outer.intervals,p.pairs.length,p.pairs.length);list(cp.histories,1,1000);
  const contexts=mapBy(cp.pairs,r=>r.pairKey),intervals=mapBy(outer.intervals,r=>r.pairKey),histories=mapBy(cp.histories,r=>r.key),usedHistories=new Set();
  const endpoints=new Map(),endpointSamples=new Map(),eventUses=new Map(),feedbackUses=new Map(),sourceGroups=new Map(),trajectoryGroups=new Map(),trajectoryTimes=new Map();
  const addFamily=(family,group)=>{text(family);check(!sourceGroups.has(family)||sourceGroups.get(family)===group,'TRANSITION_MATERIAL_SOURCE_GROUP_SPLIT');sourceGroups.set(family,group);
    check(sourceGroups.size<=10000,'TRANSITION_MATERIAL_BUDGET');};
  const reuse=(m,id,endpoint)=>{check(!m.has(id)||m.get(id)===endpoint,'TRANSITION_MATERIAL_REUSED_LABEL');m.set(id,endpoint);};
  const rows=[],pairKeys=new Set();
  for(const pair of p.pairs){
    const {root,fromTime,toTime,startedAt,groupHash}=pair;shape(root,['tenantId','type','id']);Object.values(root).forEach(text);hash(groupHash);hash(pair.partitionPolicyHash);
    const start=time(startedAt),from=time(fromTime),to=time(toTime),entity=digest([root.tenantId,root.type,root.id]);
    check(root.tenantId===p.tenantId&&root.type===c.definition.rootType&&pair.entityKey===entity&&start<=from&&(from-start)%s.stepMs===0&&to-from===s.stepMs
      &&(to-start)/s.stepMs<=recipe.timeContract.maxSteps,'TRANSITION_MATERIAL_GRID');
    check(pair.pairKey===digest([supervision.contentHash,root.tenantId,root.type,root.id,fromTime,toTime])&&!pairKeys.has(pair.pairKey),'TRANSITION_MATERIAL_PAIR');pairKeys.add(pair.pairKey);
    const trajectory=key([groupHash,pair.partitionPolicyHash,startedAt]);check(!trajectoryGroups.has(entity)||trajectoryGroups.get(entity)===trajectory,'TRANSITION_MATERIAL_TRAJECTORY_SPLIT');trajectoryGroups.set(entity,trajectory);
    const timeline=trajectoryTimes.get(entity)??new Set();timeline.add(from);timeline.add(to);trajectoryTimes.set(entity,timeline);
    const missing=[],pairFamilies=new Set(),episodeIds=new Set(),pairReviews=new Set();
    const pointSet=(points,target)=>{
      list(points,supervision.layout.stateVariables.length,supervision.layout.stateVariables.length);
      check(same(points.map(pt=>pt.variable).sort(),supervision.layout.stateVariables),'TRANSITION_MATERIAL_COMPONENTS');
      const state={};
      for(const pt of points){
        const input=pt.input.compiledInput,part=pt.partition,endpointKey=key([entity,target,pt.variable]);
        const canonicalPoint=key(pt);check(!endpoints.has(endpointKey)||endpoints.get(endpointKey)===canonicalPoint,'TRANSITION_MATERIAL_ENDPOINT_CONFLICT');endpoints.set(endpointKey,canonicalPoint);
        check(!endpointSamples.has(pt.sampleKey)||endpointSamples.get(pt.sampleKey)===endpointKey,'TRANSITION_MATERIAL_MEMBERSHIP');endpointSamples.set(pt.sampleKey,endpointKey);
        const d=datasets.get(pt.enrollment.reference.id);check(d&&same(d.enrollment,pt.enrollment)&&d.sampleKeys.includes(pt.sampleKey)&&d.protocol.variable===pt.variable,'TRANSITION_MATERIAL_MEMBERSHIP');actualMembers.add(pt.sampleKey);
        const q=d.protocol,visible=time(input.visibleAt),reserved=time(part.reservedAt),enrolled=time(pt.enrollment.approvedAt);
        check(pt.root.tenantId===root.tenantId&&pt.root.type===root.type&&pt.root.id===root.id&&pt.targetTime===target
          &&input.targetTime===target&&input.startedAt===startedAt&&input.definitionHash===c.definitionHash&&input.bindingHash===s.bindingHash&&input.classification===s.classification
          &&visible>=time(target)&&reserved>=visible&&visible>=time(q.inputVisibleFrom)&&visible<=time(q.inputVisibleUntil)
          &&part.partition===partition&&part.groupHash===groupHash&&part.policyHash===pair.partitionPolicyHash,'TRANSITION_MATERIAL_ENDPOINT');
        check(pt.input.reference.type==='PlusInputSnapshot'&&part.reference.type==='PlusPartitionReservation'&&pt.episodeLink.type==='PlusSnapshotEpisode','TRANSITION_MATERIAL_REFERENCE_TYPE');
        hash(pt.input.inputHash);text(pt.episodeId);episodeIds.add(pt.episodeId);addRef(pt.input.reference);addRef(part.reference);addRef(pt.episodeLink);
        list(input.events,0,1000);for(const e of input.events){check(time(e.receivedAt)<=visible&&time(e.eventTime)<=time(target),'TRANSITION_MATERIAL_FUTURE_INPUT');
          check(!(e.kind==='VERIFICATION'&&e.verificationMode==='GOLD'&&e.variable===pt.variable&&e.eventTime===target),'TRANSITION_MATERIAL_PRELABEL_INPUT');
          addFamily(e.dependenceKey,groupHash);pairFamilies.add(e.dependenceKey);}
        list(pt.labels,0,1000);check(pt.status===(pt.labels.length?'QUALIFIED_ENDPOINT':'MISSING_GOLD'),'TRANSITION_MATERIAL_MISSING');
        if(!pt.labels.length)missing.push(pt.sampleKey);
        for(const label of pt.labels){
          const received=time(label.receivedAt),approved=approvals(label),qualified=label.event.qualification;
          check(label.targetTime===target&&label.value.kind==='VALUE'&&c.variables.find(v=>v.key===pt.variable).support.some(v=>same(v,label.value.value)),'TRANSITION_MATERIAL_LABEL');
          check(received>visible&&received>reserved&&received>enrolled&&received>=time(q.labelReceivedFrom)&&received<=time(q.labelReceivedUntil)
            &&approved>=received&&approved<=time(q.approvalUntil)&&time(label.matureAt)>=received,'TRANSITION_MATERIAL_LABEL_TIME');
          check(qualified.allowed===true&&qualified.learningEligible===true&&qualified.verificationMode==='GOLD'&&qualified.dependenceKey===label.sourceFamilyKey,'TRANSITION_MATERIAL_LABEL');
          check(!Object.hasOwn(state,pt.variable)||same(state[pt.variable],label.value.value),'TRANSITION_MATERIAL_CONTRADICTORY_GOLD');state[pt.variable]=label.value.value;
          check(!pairReviews.has(label.feedback.id),'TRANSITION_MATERIAL_DUPLICATE_LABEL');pairReviews.add(label.feedback.id);
          reuse(eventUses,label.event.reference.id,endpointKey);reuse(feedbackUses,label.feedback.id,endpointKey);
          check(label.feedback.type==='PlusFeedback'&&label.labelSnapshot.type==='PlusInputSnapshot'&&label.event.reference.type==='PlusEvent','TRANSITION_MATERIAL_REFERENCE_TYPE');
          addRef(label.feedback);addRef(label.labelSnapshot);addRef({...label.event.reference,hash:label.event.hash},'EVENT_CONTENT');
          addFamily(label.sourceFamilyKey,groupHash);pairFamilies.add(label.sourceFamilyKey);
        }
      }
      return state;
    };
    const fromState=pointSet(pair.from,fromTime),toState=pointSet(pair.to,toTime);
    check(episodeIds.size===1,'TRANSITION_MATERIAL_EPISODE');
    check(same([...missing].sort(),pair.missingSampleKeys)&&pair.status===(missing.length?'MISSING_GOLD':'ENDPOINTS_QUALIFIED'),'TRANSITION_MATERIAL_MISSING');
    const context=contexts.get(pair.pairKey);check(context,'TRANSITION_MATERIAL_CONTEXT');
    const values={};shape(context.context,supervision.layout.contextVariables);
    check(same(context.historyKeys,pair.from.map(pt=>digest([pt.input.reference.id,fromTime]))),'TRANSITION_MATERIAL_HISTORY');
    for(let i=0;i<pair.from.length;i++){
      const pt=pair.from[i],h=histories.get(context.historyKeys[i]);check(h,'TRANSITION_MATERIAL_HISTORY');usedHistories.add(h.key);
      const m=h.material,v=m.temporalInput;check(digest({temporalInput:v,readSet:m.readSet})===m.contentHash,'TRANSITION_MATERIAL_INTEGRITY');
      check(m.readSet.snapshot.id===pt.input.reference.id&&m.readSet.snapshot.version===pt.input.reference.version&&m.readSet.snapshotHash===pt.input.inputHash
        &&same(v.rootReference,pt.root)&&v.definitionHash===c.definitionHash&&v.bindingHash===s.bindingHash&&v.classification===s.classification
        &&v.startedAt===startedAt&&v.visibleAt===fromTime&&v.targetTime===fromTime&&v.episodeKey===pt.episodeId,'TRANSITION_MATERIAL_HISTORY');
      const frame=v.contexts.at(-1);check(frame&&time(frame.effectiveAt)<=from&&time(frame.recordedAt)<=from,'TRANSITION_MATERIAL_FUTURE_CONTEXT');
      for(const r of m.readSet.contextHistory)addRef({...r.reference,hash:r.projectionHash},'CONTEXT_PROJECTION');
      for(const name of supervision.layout.contextVariables){const value=frame.values[name],source=frame.sources.find(r=>r.variable===name),provenance=source&&m.readSet.contextHistory.find(r=>same(r.reference,source.reference));
        check(source&&provenance&&s.contextSupport[name].some(v=>same(v,value)),'TRANSITION_MATERIAL_CONTEXT');
        check(!Object.hasOwn(values,name)||same(values[name],value),'TRANSITION_MATERIAL_CONTEXT');values[name]=value;
        if(i===0)check(same(context.context[name],{value,eventTime:frame.effectiveAt,receivedAt:frame.recordedAt,
          reference:{id:source.reference.id,version:source.reference.version,hash:provenance.projectionHash}}),'TRANSITION_MATERIAL_CONTEXT');
      }
    }
    const interval=intervals.get(pair.pairKey)?.material;check(interval,'TRANSITION_MATERIAL_ACTION');signed(interval);
    if(['plus-native-action-interval-policy-v2','plus-native-action-interval-policy-v3'].includes(recipe.actionHistoryContract.version))actionIntervalDependencies(interval);
    check(interval.schema==='plus-native-action-interval-v1'&&interval.actionIntervalAuthorityChecked===true&&interval.coverage==='COMPLETE_GOVERNED_NATIVE_ACTION_INTERVAL'
      &&interval.tenantId===root.tenantId&&interval.root.tenantId===root.tenantId&&interval.root.type===root.type&&interval.root.id===root.id&&interval.episodeId===[...episodeIds][0]
      &&interval.definitionHash===c.definitionHash&&interval.bindingHash===s.bindingHash&&interval.startedAt===startedAt&&interval.fromTime===fromTime&&interval.toTime===toTime
      &&time(interval.knowledgeCutoff)>=to&&same(interval.policy,recipe.actionHistoryContract)&&interval.policyHash===digest(recipe.actionHistoryContract)
      &&same(interval.readSet.nativeEpoch,p.readSet.nativeEpoch)&&interval.readSet.authorizationRevision===p.readSet.authorizationRevision,'TRANSITION_MATERIAL_ACTION');
    for(const pt of [...pair.from,...pair.to])for(const label of pt.labels)check(time(label.matureAt)<=time(interval.knowledgeCutoff),'TRANSITION_MATERIAL_LABEL_TIME');
    check(interval.episode.type==='PlusEpisode'&&interval.episode.id===interval.episodeId,'TRANSITION_MATERIAL_REFERENCE_TYPE');
    addRef(interval.episode);for(const r of interval.readSet.references)addRef(r);
    list(interval.executions,0,1);let control='WAIT';
    for(const e of interval.executions){
      text(e.executedBy);check(time(e.executedAt)>=from&&time(e.executedAt)<to,'TRANSITION_MATERIAL_ACTION');
      const bound=c.definition.actions.filter(a=>a.nativeAction===e.nativeAction&&s.controls.includes('ACTION:'+a.key));
      check(bound.length===1&&recipe.actionHistoryContract.nativeActions.includes(e.nativeAction),'TRANSITION_MATERIAL_ACTION_BINDING');control='ACTION:'+bound[0].key;
      check(e.request.type==='PlusActionRequest'&&e.decision.type==='PlusActionDecision'&&e.nativeReceipt.type==='NativeCommandReceipt','TRANSITION_MATERIAL_REFERENCE_TYPE');
      addRef(e.request);addRef(e.decision);addRef(e.nativeReceipt);list(e.journals,2,2);
      check(e.journals[0].id!==e.journals[1].id&&e.journals.every(r=>r.type==='PlusOutbox'),'TRANSITION_MATERIAL_REFERENCE_TYPE');e.journals.forEach(r=>addRef(r));
    }
    rows.push({pairKey:pair.pairKey,entityKey:entity,groupHash,fromTime,toTime,from:fromState,to:toState,context:values,control,parameterControl:supervision.layout.parameterControl[control],
      sourceFamilyKeys:[...pairFamilies].sort(),status:missing.length?'MISSING_GOLD':'QUALIFIED',missingSampleKeys:[...missing].sort()});
  }
  check(same([...actualMembers].sort(),[...declaredMembers].sort())&&usedHistories.size===histories.size,'TRANSITION_MATERIAL_MEMBERSHIP');
  check(trajectoryGroups.size<=s.budget.maxTrajectories,'TRANSITION_MATERIAL_BUDGET');
  for(const [entity,times]of trajectoryTimes){const ordered=[...times].sort((a,b)=>a-b);for(let i=1;i<ordered.length;i++){
    check(ordered[i]-ordered[i-1]===s.stepMs&&rows.some(r=>r.entityKey===entity&&time(r.fromTime)===ordered[i-1]&&time(r.toTime)===ordered[i]),'TRANSITION_MATERIAL_GAP');}}
  const missingCount=rows.filter(r=>r.status==='MISSING_GOLD').length;
  check(same(p.coverage,{enrolledEndpoints:actualMembers.size,trajectories:trajectoryGroups.size,plannedPairs:rows.length,pairsWithGold:rows.length-missingCount,missingPairs:missingCount}),'TRANSITION_MATERIAL_COVERAGE');
  check(same(p.sourceFamilyKeys,[...sourceGroups.keys()].sort()),'TRANSITION_MATERIAL_SOURCES');
  for(const r of p.readSet.references)addRef(r);
  return {rows,referenceEvidence:[...refs.values()].sort((a,b)=>key(a).localeCompare(key(b))),sourceFamilyKeys:[...sourceGroups.keys()].sort(),
    planHash:outer.contentHash,cohortIds:p.datasets.map(d=>d.enrollment.reference.id).sort(),datasetIds:p.datasets.map(d=>d.reference.id).sort(),
    nativeReadSet:structuredClone(p.readSet),authorityChecked:false,trainingAuthorized:false,predictionReady:false};
}

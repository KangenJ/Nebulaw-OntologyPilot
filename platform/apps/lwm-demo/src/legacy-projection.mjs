// Frozen v1 read contract. New schema fields/types do not silently inherit v1 viewer access.
const fields = {
  Matter:'id workspaceKey matterNumber title jurisdiction status currentState riskBand owner summary openedAt dueAt observations proposals tasks',
  RuleVersion:'id workspaceKey ruleKey title versionTag lifecycle effectiveFrom sourceCitation deterministic',
  Observation:'id workspaceKey observationNumber title kind source summary confidence verified recordedBy verifiedBy observedAt matter',
  TransitionProposal:'id workspaceKey proposalNumber title fromState toState status riskBand confidence rationale evidenceSummary gateStatus gateReason createdAt matter proposedBy simulationId plannedOptionIndex basisObservationId basisObservationVersion model reviews',
  HumanReview:'id workspaceKey reviewNumber title reviewer decision previousState appliedState note reviewedAt proposal feedback',
  InvestigationTask:'id workspaceKey taskNumber title status priority assignee instructions dueAt createdAt completedAt matter',
  FeedbackEvent:'id workspaceKey eventNumber title outcome label reason eligibility modelVersion createdAt review model',
  ModelVersion:'id workspaceKey modelKey title versionLabel stage trainingWindow validationScore calibrationError approvedBy approvedAt rollbackTarget createdAt proposals feedbackEvents',
  NativeCommandReceipt:'id commandKey commandHash actorId actionName resultType resultId traceId createdAt',
  WorkspaceControl:'id key updatedAt', ImportBatch:'id key source mappingJson reportJson createdBy createdAt',
  OntologyDraft:'id key definitionJson status createdBy approvedBy createdAt',
  SimulationRun:'id key matterId matterVersion inputJson outputJson modelHash policyId createdBy createdAt',
  OutcomeRecord:'id key simulationId matterId optionIndex actual evidence recordedBy verifiedBy status privacyConfirmed createdAt',
  DecisionPolicy:'id key artifactJson datasetJson evaluationJson trainedBy approvedBy stage parentId createdAt artifactHash evaluationHash',
  TrajectoryFeedback:'id key outcomeId mechanismKey split actionsJson source protocol status recordedBy verifiedBy verificationNote privacyConfirmed createdAt',
  LearningDataset:'id key rowsJson contentHash status createdBy createdAt', MigrationRecord:'id key sourceHash reportJson createdBy createdAt',
};
const links = new Set('MatterObservation MatterProposal ProposalReview MatterTask ModelProposal ReviewFeedback ModelFeedback'.split(' '));
const actions = {
  NativeImportMatter:'matterNumber title jurisdiction currentState evidence source commandKey commandHash traceId',
  NativeVerifyObservation:'observation expectedVersion commandKey commandHash traceId',
  NativeProposeTransition:'matter observation expectedVersion toState rationale commandKey commandHash traceId',
  NativeReviewTransition:'matter proposal observation expectedVersion decision note commandKey commandHash traceId',
  NativePlusCommand:'operation workspace expectedWorkspaceVersion matter expectedMatterVersion observation expectedObservationVersion draft policy activePolicy outcome simulation feedback trajectory dataset',
};
const objectSystem='_id _tenantId _type _version _createdAt _updatedAt _deletedAt'.split(' ');
const linkSystem=[...objectSystem,'_fromType','_fromId','_toType','_toId'];
const legacyOperations='importBatch draftOntology publishOntology simulate propose recordOutcome qualifyOutcome withdrawOutcome migrateLegacy recordTrajectory qualifyTrajectory withdrawTrajectory freezeDataset trainModel publishModel rollbackModel'.split(' ');
const auditActions=new Set([...Object.keys(actions),...Object.keys(actions).map(name=>'/actions/'+name),
  ...legacyOperations.flatMap(name=>['NativePlusCommand:'+name,'/plus/'+name])]);
const pick=(value,names)=>Object.fromEntries(names.filter(name=>Object.hasOwn(value,name)).map(name=>[name,value[name]]));

export function createLegacyProjection(schema, drafts=[]) {
  const allowed = new Map(Object.entries(fields).map(([type,names])=>[type,new Set(names.split(' '))]));
  // Preserve already approved v1 additive scalar edits, but never grant access
  // based merely on a newly discovered native field or sensitive definition.
  for(const draft of drafts){
    if(draft.status!=='APPROVED'||!draft.approvedBy)continue;
    let definition;try{definition=JSON.parse(draft.definitionJson);}catch{continue;}
    if(!['Matter','Observation'].includes(definition.type)||!Array.isArray(definition.fields))continue;
    for(const field of definition.fields){
      const actual=schema.objectTypes.find(t=>t.name===definition.type)?.fields.find(f=>f.name===field.name);
      if(actual && /^[a-z][A-Za-z0-9]{1,39}$/.test(field.name) && ['String','Float','Int','Boolean'].includes(field.type)
        && actual.type.name===field.type && !actual.type.isList && actual.directives.length===0)allowed.get(definition.type).add(field.name);
    }
  }
  const objectTypes=schema.objectTypes.filter(t=>allowed.has(t.name)).map(t=>({...t,fields:t.fields.filter(f=>allowed.get(t.name).has(f.name))}));
  const linkTypes=schema.linkTypes.filter(t=>links.has(t.name)&&allowed.has(t.from)&&allowed.has(t.to)).map(t=>({...t,fields:t.fields.filter(f=>['id','linkedAt'].includes(f.name))}));
  const actionTypes=schema.actionTypes.filter(t=>Object.hasOwn(actions,t.name)).map(t=>({...t,fields:t.fields.filter(f=>actions[t.name].split(' ').includes(f.name))}));
  const referenced=new Set([...objectTypes,...linkTypes,...actionTypes].flatMap(t=>t.fields.map(f=>f.type.name)));
  const projectedSchema={namespace:schema.namespace,objectTypes,linkTypes,actionTypes,enums:schema.enums.filter(e=>referenced.has(e.name)),interfaces:[],scalars:schema.scalars.filter(s=>referenced.has(s.name))};
  function object(value){
    if(!value || !allowed.has(value._type) || value._tenantId!=='lwm-demo')return null;
    const definition=objectTypes.find(t=>t.name===value._type);
    const scalarFields=definition?.fields.filter(f=>!f.directives.some(d=>['link','computed'].includes(d.kind))).map(f=>f.name)??[];
    return pick(value,[...objectSystem,...scalarFields]);
  }
  function link(value){return value && links.has(value._type) && value._tenantId==='lwm-demo'?pick(value,[...linkSystem,'id','linkedAt']):null;}
  function states(value){return Object.fromEntries(Object.entries(value??{}).flatMap(([key,item])=>{
    const projected=key.startsWith('link:')?link(item):object(item);return projected?[[key,projected]]:[];
  }));}
  function audit(record){
    if(record.tenantId && record.tenantId!=='lwm-demo')return null;
    if(!auditActions.has(record.operation?.actionType??''))return null;
    const detail=record.detail??{};
    return {...pick(record,['id','timestamp','traceId']),actor:pick(record.actor??{},['id','type','roles']),operation:pick(record.operation,['type','actionType','actionId']),
      detail:{...pick(detail,['result','denialReason']),...(detail.before?{before:states(detail.before)}:{}),...(detail.after?{after:states(detail.after)}:{})}};
  }
  return {schema:projectedSchema,object,link,audit,hasType:type=>allowed.has(type)};
}

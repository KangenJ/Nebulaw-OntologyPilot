/** Reviewable G1 binding. No model, dataset or deployment is implicitly approved by constructing it. */
export function taskEpisodeBinding(){
  return {version:'plus-episode-binding-v1',rootType:'InvestigationTask',rootEpisodeLink:'TaskPlusEpisode',rootEventLink:'TaskPlusEvent',classificationField:'dataClassification',sources:[
    {kind:'OBSERVATION',variable:'report',sourceType:'Observation',sourceLink:'EventSourceObservation',rootSourceLink:'TaskObservation',valueField:'reportedCompletion',eventTimeField:'observedAt',receivedTimeField:'receivedAt',
      qualificationFields:['workspaceKey','dataClassification','recordedBy','channelKey','sourceSystem','sourceRecordId','sourceRevision','sourceEventKey']},
    {kind:'VERIFICATION',variable:'completion',sourceType:'TaskCompletionVerification',sourceLink:'EventSourceTaskVerification',rootSourceLink:'TaskCompletionCheck',valueField:'result',eventTimeField:'targetTime',receivedTimeField:'recordedAt',
      qualificationFields:['taskVersion','observationVersion','recordedBy','methodKey','mode','classification']},
  ]};
}

export function taskMechanismDefinition(){
  const policyId='synthetic-task-purpose-v1',verification='independent-task-check-v1';
  const common={unit:'1',unknownValues:[],missingPolicy:{absent:'UNOBSERVED',null:'MISSING',withdrawn:'REVOKED'},verification:{policyRef:verification,mode:'NONE'},accessPolicyRef:policyId,transform:{kind:'IDENTITY'}};
  const rootTime={eventTimeField:'createdAt',receivedTimeField:'receivedAt'};
  const definition={schema:'plus-mechanism-v1',key:'task.completion',revision:1,title:'Synthetic task completion and independent verification',rootType:'InvestigationTask',scope:{key:'synthetic',policyRef:'synthetic-task-scope-v1'},variables:[
    {...structuredClone(common),key:'completion',role:'LATENT',source:{objectType:'InvestigationTask',field:'actualCompletion'},valueType:'TaskCompletion',nullable:true,support:['DONE','NOT_DONE'],unknownValues:['UNKNOWN'],time:{eventTimeField:'actualCompletionAt',receivedTimeField:'actualCompletionRecordedAt'},verification:{policyRef:verification,mode:'GOLD'}},
    {...structuredClone(common),key:'priority',role:'CONTEXT',source:{objectType:'InvestigationTask',field:'priority'},valueType:'RiskBand',nullable:false,support:['LOW','MEDIUM','HIGH','CRITICAL'],time:rootTime},
    {...structuredClone(common),key:'administrativeStatus',role:'CONTEXT',source:{objectType:'InvestigationTask',field:'status'},valueType:'TaskStatus',nullable:false,support:['OPEN','IN_PROGRESS','COMPLETED','CANCELLED'],time:rootTime},
    {...structuredClone(common),key:'report',role:'OBSERVATION',source:{objectType:'Observation',field:'reportedCompletion',path:{linkType:'TaskObservation',direction:'OUTBOUND',aggregation:'LATEST'}},valueType:'TaskCompletion',nullable:true,support:['DONE','NOT_DONE'],unknownValues:['UNKNOWN'],time:{eventTimeField:'observedAt',receivedTimeField:'receivedAt'}},
  ],modules:[{key:'transition',kind:'TRANSITION',inputs:['completion','priority'],outputs:['completion'],dependsOn:[],implementation:'categorical-transition-v1'},
    {key:'observation',kind:'OBSERVATION',inputs:['completion'],outputs:['report'],dependsOn:['transition'],implementation:'categorical-observation-v1'}],
  // A governed request-verification action is added in T05; observation verification is not a planning action.
  actions:[],budget:{mechanisms:8,horizon:4,alternatives:2,branchDepth:1},
  utility:{target:'completion',decisions:['DONE','NOT_DONE'],losses:[[0,10],[3,0]],verificationCost:1,minimumDifference:0.1,unit:'synthetic_utility'}};
  const fieldSemantics={
    'InvestigationTask.actualCompletion':{unit:'1',roles:['LATENT','FACT'],knowledgeOnlyValues:['UNKNOWN']},
    'InvestigationTask.priority':{unit:'1',roles:['CONTEXT']},'InvestigationTask.status':{unit:'1',roles:['CONTEXT']},
    'Observation.reportedCompletion':{unit:'1',roles:['OBSERVATION'],knowledgeOnlyValues:['UNKNOWN']},
  };
  for(const name of ['InvestigationTask.createdAt','InvestigationTask.receivedAt','InvestigationTask.actualCompletionAt','InvestigationTask.actualCompletionRecordedAt','Observation.observedAt','Observation.receivedAt'])fieldSemantics[name]={unit:'timestamp_utc',roles:['CONTEXT']};
  return {definition,policy:{id:policyId,readableFields:Object.keys(fieldSemantics),actionNames:[],implementationIds:['categorical-transition-v1','categorical-observation-v1'],scopePolicies:['synthetic-task-scope-v1'],verificationPolicies:[verification],fieldSemantics}};
}

/** Opt-in revision 2. Requires reviewed priority ontology and fresh model evaluation/consent. */
export function taskTimedMechanismDefinition(){
  const result=taskMechanismDefinition(),initial={eventTimeField:'createdAt',receivedTimeField:'receivedAt'};
  result.definition.revision=2;
  result.definition.title='Synthetic task completion with reviewed priority history';
  result.definition.variables.find(v=>v.key==='priority').time={eventTimeField:'priorityEffectiveAt',receivedTimeField:'priorityRecordedAt',initial};
  result.policy.initialContextTimes={'InvestigationTask.priority':structuredClone(initial)};
  for(const field of ['priorityEffectiveAt','priorityRecordedAt']){
    result.policy.readableFields.push('InvestigationTask.'+field);
    result.policy.fieldSemantics['InvestigationTask.'+field]={unit:'timestamp_utc',roles:['CONTEXT']};
  }
  return result;
}

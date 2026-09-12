import { compileDefinition,compileTransitionSupervision,digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { fixture } from '../../platform/packages/plus-contracts/tests/fixture.mjs';
import { transitionRecipe,transitionPairKey } from './transition-fit.mjs';
export const at=s=>new Date(Date.UTC(2026,0,1)+s*1000).toISOString();
const ref=id=>({id,version:1,hash:digest(id)});
export const rehash=m=>({...m,contentHash:digest(Object.fromEntries(Object.entries(m).filter(([k])=>k!=='contentHash')))});

// Structurally complete SYNTHETIC evidence; not native-current authority.
export function transitionFixture(){
  const f=fixture({root:'Machine',signal:'Telemetry',enumName:'Mode',states:['READY','BUSY','OFFLINE']}),compiled=compileDefinition(f.definition,f.context);
  const specification={schema:'plus-transition-supervision-v1',key:'machine.transition',revision:1,parentDefinitionHash:compiled.definitionHash,
    bindingHash:digest('binding'),timeContractHash:digest('time'),transitionModule:'transition',classification:'SYNTHETIC',
    collectionPolicyHash:digest('collection'),populationPolicyHash:digest('population'),stepMs:60000,contextSupport:{priority:[1,2]},
    controls:['WAIT','ACTION:verify'],sampling:'ALL_ADJACENT_PRE_ENROLLED_PAIRS',actionSemantics:'OBSERVED_NATIVE_HISTORY_NOT_CAUSAL',budget:{maxPairs:100,maxTrajectories:20}};
  const supervision=compileTransitionSupervision(specification,compiled),config={classification:'SYNTHETIC',collectionPolicyHash:specification.collectionPolicyHash,
    populationPolicyHash:specification.populationPolicyHash,trainingProtocolHashes:[digest('round-1'),digest('round-2')],smoothingAlpha:1,
    minimumPairs:1,minimumTrajectories:1,minimumGroups:1,minimumPerCondition:1,minimumCoverage:0.5};
  const {recipe}=transitionRecipe(compiled,supervision,config);
  const material=(batch,intervals)=>{
    const enrollment={reference:ref('cohort-'+batch),approvedAt:at(-1),proposedBy:'trainer',approvedBy:'independent-reviewer',plannedPairs:[]},samples=[];
    const endpoint=(root,time,value)=>({root,definitionHash:compiled.definitionHash,bindingHash:specification.bindingHash,classification:'SYNTHETIC',
      startedAt:at(0),targetTime:at(time),visibleAt:at(time),input:ref(root.id+'-input-'+time),
      partition:{...ref(root.id+'-partition-'+time),partition:'TRAIN',policyHash:digest('split-policy'),groupHash:digest('group-'+root.id),reservedAt:at(time+1)},
      labels:[{variable:'state',value,event:ref(root.id+'-gold-'+time),feedback:ref(root.id+'-feedback-'+time),mode:'GOLD',targetTime:at(time),
        sourceFamilyKey:'inspection-'+root.id,receivedAt:at(time+120),approvedAt:at(time+121),proposedBy:'observer',approvedBy:'reviewer'}]});
    for(const {id,from='READY',to='BUSY',time=0,priority=1,action=false,missing=false}of intervals){
      const root={tenantId:'synthetic',type:'Machine',id},fromTime=at(time),toTime=at(time+60),pairKey=transitionPairKey(supervision.contentHash,root,fromTime,toTime);
      enrollment.plannedPairs.push({pairKey,root,startedAt:at(0),fromTime,toTime,groupHash:digest('group-'+id),inputSourceFamilyKeys:['report-'+id],
        inputReferences:[ref(id+'-input-'+time),ref(id+'-input-'+(time+60))]});
      const {plannedPairs,...enrollmentBase}=enrollment;
      samples.push({pairKey,evidence:missing?null:{schema:'plus-transition-pair-evidence-v1',supervisionHash:supervision.contentHash,
        enrollment:{...enrollmentBase.reference,approvedAt:enrollmentBase.approvedAt,proposedBy:enrollmentBase.proposedBy,approvedBy:enrollmentBase.approvedBy},
        from:endpoint(root,time,from),to:endpoint(root,time+60,to),
        context:{priority:{value:priority,eventTime:at(0),receivedAt:at(0),reference:ref('context-'+id)}},
        actionHistory:{reference:ref(id+'-interval-'+time),fromTime,toTime,knowledgeCutoff:at(time+61),coverage:'COMPLETE_NATIVE_INTERVAL',
          receipts:action?[{reference:ref(id+'-receipt-'+time),nativeAction:'VerifyObject',executedAt:at(time+1)}]:[]}}});
    }
    return rehash({schema:'plus-transition-fit-material-v1',supervisionHash:supervision.contentHash,classification:'SYNTHETIC',purpose:'FIT',
      protocolHash:digest(batch),enrollment,samples});
  };
  return {compiled,supervision,recipe,material};
}

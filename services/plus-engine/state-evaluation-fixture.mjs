// Synthetic temporal envelopes for algorithm tests, not native qualification.
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
export function temporalFor(data){return data.sourceManifest.samples.map(sample=>{
  const ref={tenantId:'state-software-test',type:'Machine',id:sample.entityKey,version:1,schemaRevision:'software-schema'};
  const input=sample.input;
  const temporalInput={schema:'plus-temporal-input-v1',definitionHash:input.definitionHash,bindingHash:input.bindingHash,classification:input.classification,
    episodeKey:sample.entityKey,rootReference:ref,startedAt:input.startedAt,visibleAt:input.visibleAt,targetTime:input.targetTime,
    contexts:[{effectiveAt:input.startedAt,recordedAt:input.startedAt,values:{priority:input.features.priority.value},sources:[{variable:'priority',reference:ref}]}],
    events:input.events.map(event=>({event:structuredClone(event),sourceReference:{...ref,type:'SensorReading',id:event.key}}))};
  const readSet={snapshot:{...ref,type:'PlusInputSnapshot',id:sample.inputSnapshotId},snapshotHash:sample.inputHash};
  return {temporalInput,readSet,contentHash:digest({temporalInput,readSet}),predictionReady:false};
});}

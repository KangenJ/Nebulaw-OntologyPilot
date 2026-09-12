// Isolated experimental assembly. Not a native recipe, approval or production model.
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
export async function candidateFactory(root){
  const imp=p=>import(pathToFileURL(join(root,p)).href);
  const {compileDefinition}=await imp('platform/packages/plus-contracts/dist/index.js');
  const {fixture}=await imp('platform/packages/plus-contracts/tests/fixture.mjs');
  const {fittingContract,fittingConfig,syntheticMaterialForUnitTest}=await imp('services/plus-engine/observation-fit-fixture.mjs');
  const {fitObservationModel}=await imp('services/plus-engine/observation-fit.mjs');
  const {transitionFixture}=await imp('services/plus-engine/transition-fit-fixture.mjs');
  const {fitTransitionModel}=await imp('services/plus-engine/transition-fit.mjs');
  const {createFiniteEngine}=await imp('services/plus-engine/finite-engine.mjs');
  const names=['READY','BUSY','OFFLINE'],{compiled,baseline}=fittingContract(),tf=transitionFixture();
  const f=fixture({root:'Machine',signal:'SensorReading',enumName:'MachineState',states:names});
  // Explicit synthetic ontology extension, never alter a compiled hash by hand.
  const baseVariable=structuredClone(compiled.variables.find(v=>v.key==='report'));
  // Use the source definition shape rather than compiled-only metadata.
  const report=f.definition.variables.find(v=>v.key==='report');report.support=[...names];report.unknownValues=['UNKNOWN'];report.nullable=true;
  const object=f.context.parsed.objectTypes.find(t=>t.name==='SensorReading'),field=object.fields.find(v=>v.name==='report');field.type.nonNull=false;
  const spi=f.context.spiSchema.objectTypes.find(t=>t.name==='SensorReading'),property=spi.properties.find(v=>v.name==='report');property.required=false;
  f.context.policy.fieldSemantics['SensorReading.report'].knowledgeOnlyValues=['UNKNOWN'];
  object.fields.push({...structuredClone(field),name:'secondReport'});spi.properties.push({...structuredClone(property),name:'secondReport'});
  f.context.policy.fieldSemantics['SensorReading.secondReport']=structuredClone(f.context.policy.fieldSemantics['SensorReading.report']);
  f.context.policy.readableFields.push('SensorReading.secondReport');
  f.definition.variables.push({...structuredClone(report),key:'report2',source:{...structuredClone(report.source),field:'secondReport'}});
  f.definition.modules.push({...structuredClone(f.definition.modules.find(m=>m.key==='observation')),key:'observation2',outputs:['report2']});
  const twin=compileDefinition(f.definition,f.context);assert.deepEqual(baseVariable.support,twin.variables.find(v=>v.key==='report').support);
  function fit(rows,key,{separate=true}={}){
    assert.ok(rows.length>0&&rows.length<=20);assert.equal(new Set(rows.map(r=>r.id)).size,rows.length);
    const started=performance.now();
    const observations=(separate?[0,1]:[null]).map(source=>{
      const records=rows.flatMap(row=>row.frames.flatMap(frame=>(source===null?frame.reports:[frame.reports[source]]).map(x=>({state:names[frame.y],report:names[x]}))));
      const mats=[];for(let i=0;i<records.length;i+=100)mats.push(syntheticMaterialForUnitTest(compiled,key+'-'+source+'-'+i,records.slice(i,i+100)));
      return fitObservationModel(compiled,baseline,mats,fittingConfig(mats.map(m=>m.sourceManifest.protocol)));
    });
    const intervals=rows.flatMap(row=>row.frames.slice(1).map((frame,i)=>({id:row.id,from:names[row.frames[i].y],to:names[frame.y],time:i*60})));
    const transition=fitTransitionModel(tf.recipe,[tf.material('round-1',intervals)]);
    const spec=structuredClone(observations[0].spec);spec.schema='plus-finite-spec-v2';spec.missingTransition='UNAVAILABLE';spec.controls=['WAIT'];
    for(const h of spec.hypotheses){if(separate)h.channels.push({...structuredClone(observations[1].spec.hypotheses[0].channels[0]),variable:'report2'});
      h.transition=h.transition.filter(r=>r.control==='WAIT').map(r=>{const learned=transition.table.find(v=>v.condition.control===transition.layout.parameterControl.WAIT&&v.condition.from.state===r.from.state&&v.condition.context.priority===r.context.priority);assert.ok(learned);return {...r,probabilities:learned.status==='LEARNED'?names.map(name=>({state:{state:name},p:learned.probabilities[transition.layout.states.findIndex(s=>s.state===name)]})):null};});}
    const engine=createFiniteEngine(separate?twin:compiled,spec);
    const kernels=spec.hypotheses[0].channels.map(c=>names.map(name=>names.map(report=>c.rows.find(r=>r.context.priority===1&&r.state.state===name).probabilities.find(p=>p.value.kind==='VALUE'&&p.value.value===report).p)));
    const T=names.map(name=>{const row=spec.hypotheses[0].transition.find(r=>r.context.priority===1&&r.from.state===name);return row.probabilities?names.map(to=>row.probabilities.find(p=>p.state.state===to).p):null;});
    return {fitMs:performance.now()-started,T,E:separate?kernels:[kernels[0],kernels[0]],artifacts:[...observations.map(o=>o.artifactHash),transition.artifactHash],compiledHash:(separate?twin:compiled).definitionHash,
      predict(row){try{let b=engine.initialize({episodeKey:row.id,context:{priority:1}});for(let t=0;t<row.frames.length;t++){if(t)b=engine.advance(b,{control:'WAIT',context:{priority:1}});for(let s=0;s<2;s++){const x=row.frames[t].reports[s];assert.ok(Number.isInteger(x)&&x>=0&&x<3);b=engine.update(b,{key:row.id+'-'+t+'-'+s,step:t,variable:separate&&s===1?'report2':'report',kind:'OBSERVATION',value:{kind:'VALUE',value:names[x]},dependenceKey:row.id+'-'+t+'-independent-'+s,verificationMode:'NONE'});}}const result=engine.summarize(b);return names.map(name=>result.states.find(r=>r.state.state===name).p);}catch(e){if(e.code==='TRANSITION_UNSUPPORTED')return null;throw e;}}
    };
  }
  return {fit};
}
export function chooseByValidation(scores,minimumImprovement=.02){
  const frozen=scores.find(s=>s.key==='frozen');assert.ok(frozen);
  const eligible=scores.filter(s=>s.coverage===1&&Number.isFinite(s.nll)).sort((a,b)=>a.nll-b.nll||a.key.localeCompare(b.key));
  if(!eligible.length)return {key:null,status:'NO_SUPPORTED_CANDIDATE'};
  const best=eligible[0];if(frozen.coverage===1&&best.nll>frozen.nll-minimumImprovement)return {key:'frozen',status:'INSUFFICIENT_VALIDATION_IMPROVEMENT'};
  return {key:best.key,status:'CANDIDATE_FOR_REVIEW_NOT_PUBLICATION'};
}

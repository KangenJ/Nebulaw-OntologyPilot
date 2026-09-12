import test from 'node:test';
import assert from 'node:assert/strict';
import {compileDefinition,digest} from '../../platform/packages/plus-contracts/dist/index.js';
import {fixture} from '../../platform/packages/plus-contracts/tests/fixture.mjs';
import {finiteAuthoringLayout,buildAuthoredFiniteBaseline} from './finite-authoring.mjs';
const setup=(states=['READY','BUSY','OFFLINE'],root='Machine')=>{const f=fixture({root,signal:'Reading',enumName:'OperatingState',states});
  // Generic contract fixtures leave numeric context unbounded. A finite editor
  // must NOT invent buckets/support; declare this test's reviewed support first.
  f.definition.variables.find(v=>v.key==='priority').support=[1,2,3];return compileDefinition(f.definition,f.context);};
const explicitValues=layout=>Object.fromEntries(layout.groups.flatMap(g=>g.fields.map((id,i)=>[id,i===0?1:0])));
const request={hypothesisKeys:['mobile','stable'],initialContextInputs:[]};
test('ontology-derived empty slots generate an executable finite contract only after explicit normalized values',()=>{
  const compiled=setup(),layout=finiteAuthoringLayout(compiled,request);assert.equal(layout.states.length,3);assert.ok(layout.fields.length>0);assert.equal(layout.predictionReady,false);
  assert.equal(typeof layout.baseline.hypotheses[0].prior,'object','No implicit learned or reference probabilities');
  assert.throws(()=>buildAuthoredFiniteBaseline(compiled,request,{}),/AUTHORING_VALUES/);
  const values=explicitValues(layout),baseline=buildAuthoredFiniteBaseline(compiled,request,values);assert.equal(baseline.hypotheses[0].prior,1);
  const mutated={...values,[layout.fields[0].id]:NaN};assert.throws(()=>buildAuthoredFiniteBaseline(compiled,request,mutated),/AUTHORING_PROBABILITY/);
  const bad={...values};const g=layout.groups.find(g=>g.fields.length>1);bad[g.fields[0]]=0;assert.throws(()=>buildAuthoredFiniteBaseline(compiled,request,bad),/AUTHORING_NORMALIZATION/);
});
test('field and hypothesis reordering retain semantic layout, distinct ontology support changes axes without a legal fixed vector',()=>{
  const c=setup(),a=finiteAuthoringLayout(c,request),b=finiteAuthoringLayout({...c,variables:[...c.variables].reverse()},{...request,hypothesisKeys:[...request.hypothesisKeys].reverse()});
  assert.equal(digest(a),digest(b));const different=finiteAuthoringLayout(setup(['A','B','C','D'],'Asset'),request);assert.equal(different.states.length,4);assert.notEqual(different.fields.length,a.fields.length);
});
test('declared dependency sharing prevents duplicate free parameters; unsupported axes and capacity fail closed',()=>{
  const c=setup(),layout=finiteAuthoringLayout(c,request),h=layout.baseline.hypotheses[0];
  if(h.initial.length>1)assert.deepEqual(h.initial[0].probabilities,h.initial[1].probabilities,'No initial context dependency was requested');
  assert.throws(()=>finiteAuthoringLayout(c,{...request,initialContextInputs:['notAField']}),/AUTHORING_INITIAL_CONTEXT/);
  assert.throws(()=>finiteAuthoringLayout(c,{...request,hypothesisKeys:['same','same']}),/AUTHORING_HYPOTHESES/);
  const bad=structuredClone(c);bad.variables.find(v=>v.role==='CONTEXT').sourceType.isList=true;assert.throws(()=>finiteAuthoringLayout(bad,request),/AUTHORING_SUPPORT/);
});

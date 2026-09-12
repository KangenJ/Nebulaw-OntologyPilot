import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareNativeRecipePreview,createNativeRecipeWorkbench} from '../public-plus/native-recipe-ui.js';
const options={schema:'plus-recipe-authoring-options-v1',canDraft:true,input:{engineId:'ontology-composed-observation-v1'},optionsHash:'options',layout:{fields:[{id:'a'},{id:'b'}],groups:[{fields:['a','b']}]},
  pairs:[{targetVariable:'state',observationVariable:'report'}],trainingProtocols:[{variable:'state',classification:'SYNTHETIC',collectionPolicyHash:'collection',hash:'training'}],populationPolicyHashes:['population'],ruleOptions:[{specificationHash:'rule'}]};
const values={pair:'0',protocol:'0',population:'0',rule:'0','prob.a':'0.6','prob.b':'0.4',smoothingAlpha:'1',minimumSamples:'2',minimumPerState:'1',minimumCoverage:'1'};
test('recipe form preserves numeric types and selects only authorized ontology supervision and rule references',()=>{
  const before=structuredClone(options),v=prepareNativeRecipePreview(options,values);assert.deepEqual(v.probabilities,{a:0.6,b:0.4});assert.equal(v.config.minimumSamples,2);assert.equal(v.config.classification,'SYNTHETIC');assert.equal(v.ruleSpecificationHash,'rule');assert.deepEqual(options,before);
  assert.equal(Object.hasOwn(v.config,'bindingHash'),false);assert.equal(Object.hasOwn(v,'compiled'),false);
});
test('recipe form refuses empty, nonfinite, non-normalized or unbound inputs instead of generating guessed parameters',()=>{
  for(const patch of [{'prob.a':''},{'prob.a':'Infinity'},{'prob.a':'0.9'},{protocol:'99'},{rule:'2'},{minimumSamples:'1.5'},{minimumCoverage:'2'}])assert.throws(()=>prepareNativeRecipePreview(options,{...values,...patch}));
  assert.throws(()=>prepareNativeRecipePreview({...options,canDraft:false},values));
  assert.throws(()=>prepareNativeRecipePreview({...options,pairs:[{targetVariable:'other',observationVariable:'report'}]},values));
});
test('cumulative feedback recipe selects bounded authorized compatible protocols without duplicated material',()=>{
  const o=structuredClone(options);o.trainingProtocols.push({...o.trainingProtocols[0],hash:'next-training'});
  const first=prepareNativeRecipePreview(o,{...values,protocol:'0,1'}),reverse=prepareNativeRecipePreview(o,{...values,protocol:'1,0'});
  assert.deepEqual(first,reverse);assert.deepEqual(first.config.trainingProtocolHashes,['next-training','training']);
  assert.deepEqual(first.probabilities,prepareNativeRecipePreview(options,values).probabilities);
  for(const protocol of ['',',','0,0','0,00','0,9',Array(11).fill('0').join(',')])assert.throws(()=>prepareNativeRecipePreview(o,{...values,protocol}));
  for(const change of [{variable:'other'},{classification:'AUTHORIZED_REAL'},{collectionPolicyHash:'other'},{hash:'training'}]){
    const invalid=structuredClone(o);Object.assign(invalid.trainingProtocols[1],change);assert.throws(()=>prepareNativeRecipePreview(invalid,{...values,protocol:'0,1'}));
  }
  assert.equal(options.trainingProtocols.length,1,'Options and prior input are not mutated');
});
test('native multi-select UI submits all chosen protocols, retains them after preview and invalidates changes',async()=>{
  const nodes=new Map(),$=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',value:'',disabled:false});return nodes.get(id);};let last,error,submitted;
  const selection={key:'example',definitionKey:'task.completion',engineId:'ontology-composed-observation-v1',hypothesisKeys:['h'],initialContextInputs:[]};
  const o={...structuredClone(options),input:selection,revisions:[],canReview:false,definitionHash:'d'.repeat(64)};o.trainingProtocols.push({...o.trainingProtocols[0],hash:'next-training'});o.trainingProtocols.forEach((p,i)=>p.key='train-'+i);o.layout.fields.forEach(f=>{f.label='Example';f.outcome=f.id;});
  const ui=createNativeRecipeWorkbench({document:{querySelector:$},api:async(path,epoch,body)=>{
    if(path==='/learning/recipes/options')return {schema:'plus-recipe-authoring-index-v1',readOnly:true,predictionReady:false,definitionKeys:['task.completion'],items:[{key:'example',engineIds:[selection.engineId],supportedAuthoringEngines:[selection.engineId]}]};
    if(path==='/learning/recipes/authoring-options')return {...structuredClone(o),input:structuredClone(body),readOnly:true,predictionReady:false};
    if(path==='/learning/recipes/preview'){submitted=body;return {schema:'plus-recipe-draft-preview-v1',key:'example',definitionHash:o.definitionHash,readOnly:true,predictionReady:false,trainingAuthorized:false,payload:{config:body.config},recipeHash:'e'.repeat(64)};}throw Error('Unexpected request');
  },run:fn=>{last=Promise.resolve().then(()=>fn(1)).catch(e=>error=e);return last;},isBusy:()=>false,getPrincipal:()=>({id:'trainer'})});
  const protocol=$('#recipe-protocol');protocol.options=[{value:'0',selected:false},{value:'1',selected:false}];Object.defineProperty(protocol,'selectedOptions',{get:()=>protocol.options.filter(o=>o.selected)});
  ui.render();$('#recipe-discover').onclick();await last;$('#recipe-purpose').value='0';$('#recipe-definition').value='0';$('#recipe-hypotheses').value='h';$('#recipe-contexts').value='';$('#recipe-layout-form').onsubmit({preventDefault(){}});await last;
  assert.match($('#recipe-workbench').innerHTML,/id="recipe-protocol" multiple/);for(const k of ['pair','population','rule'])$('#recipe-'+k).value='0';
  $('#recipe-prob-a').value='0.6';$('#recipe-prob-b').value='0.4';for(const k of ['smoothingAlpha','minimumSamples','minimumPerState','minimumCoverage'])$('#recipe-'+k).value=values[k];
  protocol.options.forEach(o=>o.selected=true);protocol.onchange();$('#recipe-values-form').onsubmit({preventDefault(){}});await last;assert.equal(error,undefined);
  assert.deepEqual(submitted.config.trainingProtocolHashes,['next-training','training']);assert.deepEqual(protocol.selectedOptions.map(o=>o.value),['0','1']);assert.match($('#recipe-workbench').innerHTML,/明确保存原生草稿/);
  protocol.options[0].selected=false;protocol.onchange();assert.equal($('#recipe-save').disabled,true);ui.reset();ui.render();assert.doesNotMatch($('#recipe-workbench').innerHTML,/recipe-values-form/);
});
test('recipe discovery performs no implicit requests and reset discards a late identity-bound index',async()=>{
  const nodes=new Map(),$=k=>{if(!nodes.has(k))nodes.set(k,{innerHTML:'',value:''});return nodes.get(k);};let last,release,error,busy=false,calls=0;
  const ui=createNativeRecipeWorkbench({document:{querySelector:$},api:async()=>{calls++;await new Promise(r=>release=r);return {schema:'plus-recipe-authoring-index-v1',items:[],definitionKeys:[],readOnly:true,predictionReady:false};},
    run:fn=>{busy=true;last=Promise.resolve().then(()=>fn(1)).catch(e=>error=e).finally(()=>busy=false);return last;},isBusy:()=>busy,getPrincipal:()=>({id:'trainer'})});
  ui.render();assert.equal(calls,0);$('#recipe-discover').onclick();await new Promise(r=>setImmediate(r));ui.reset();ui.render();release();await last;
  assert.equal(error.discarded,true);assert.doesNotMatch($('#recipe-workbench').innerHTML,/recipe-layout-form/);
});

test('changing layout selection invalidates the preview and rendered forms retain their explicit current selections',async()=>{
  const nodes=new Map(),$=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',value:'',disabled:false});return nodes.get(id);};let last,error;const calls=[];
  const selected={key:'example',definitionKey:'task.completion',engineId:'ontology-composed-observation-v1',hypothesisKeys:['h'],initialContextInputs:[]};
  const o={...structuredClone(options),input:selected,revisions:[],canReview:false};o.layout.fields.forEach(f=>{f.label='Example';f.outcome=f.id;});
  const ui=createNativeRecipeWorkbench({document:{querySelector:$},api:async(path,epoch,body)=>{calls.push(path);
    if(path==='/learning/recipes/options')return {schema:'plus-recipe-authoring-index-v1',readOnly:true,predictionReady:false,definitionKeys:['task.completion'],items:[{key:'example',engineIds:[selected.engineId],supportedAuthoringEngines:[selected.engineId]}]};
    if(path==='/learning/recipes/authoring-options')return {...structuredClone(o),input:structuredClone(body),readOnly:true,predictionReady:false};throw Error('Unexpected request');},
    run:fn=>{last=Promise.resolve().then(()=>fn(1)).catch(e=>error=e);return last;},isBusy:()=>false,getPrincipal:()=>({id:'trainer'})});
  ui.render();$('#recipe-discover').onclick();await last;$('#recipe-purpose').value='0';$('#recipe-definition').value='0';$('#recipe-hypotheses').value='h';$('#recipe-contexts').value='';
  $('#recipe-layout-form').onsubmit({preventDefault(){}});await last;assert.equal(error,undefined);assert.equal($('#recipe-purpose').value,'0');assert.equal($('#recipe-hypotheses').value,'h');
  $('#recipe-hypotheses').value='changed';$('#recipe-hypotheses').oninput();$('#recipe-values-form').onsubmit({preventDefault(){}});await last;
  assert.match(error.message,/重新生成布局/);assert.equal(calls.includes('/learning/recipes/preview'),false);assert.equal($('#recipe-hypotheses').value,'changed');
  assert.equal($('#recipe-save').disabled,true);ui.reset();ui.render();assert.doesNotMatch($('#recipe-workbench').innerHTML,/recipe-layout-form/);
});

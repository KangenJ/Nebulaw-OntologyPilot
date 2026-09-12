import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeModelReview} from '../public-plus/native-model-review-ui.js';

// Shipped handlers with DOM/API adapters, not a browser or numerical model test.
function fixture(){const nodes=new Map(),$=s=>{if(!nodes.has(s))nodes.set(s,{});return nodes.get(s);};
  let busy=false,error,hold,p={id:'owner',tenantId:'native',roles:['model_owner']};const calls=[],submitted=[];
  const option={optionKey:'a'.repeat(64),key:'task.model',scope:{modelKind:'COMPLETE_MODEL',classification:'SYNTHETIC',definitionHash:'d'.repeat(64),bindingHash:'e'.repeat(64),scopeKey:'<img onerror=x>',task:'STATE_ESTIMATION'},
    score:{id:'score',version:1,contentHash:'b'.repeat(64),createdBy:'trainer',createdAt:'now',evidence:{candidateId:'candidate',artifactHash:'f'.repeat(64),trainingDatasets:[{id:'train'}],validationDatasets:[{id:'validate'}]},
      result:{decision:'ELIGIBLE_FOR_REVIEW',deploymentAuthorized:false,metrics:{candidate:{meanNll:0.2},baseline:{meanNll:0.4}}}},
    recipe:{id:'recipe',version:2,recipeHash:'c'.repeat(64)},protocol:{id:'protocol',version:2,contentHash:'f'.repeat(64),configuration:{maximumNllRegression:0},reference:null},
    qualification:'NOT_CHECKED',unavailableReasons:[],approvalUnavailableReasons:[],command:{key:'task.model',evaluationId:'score',evaluationVersion:1}};
  const response={schema:'plus-model-decision-review-v1',keys:['task.model'],items:[option],qualification:'NOT_CHECKED',readOnly:true,predictionReady:false,executionAuthorized:false};
  const run=async fn=>{busy=true;try{return await fn(1);}catch(e){error=e;}finally{busy=false;}};
  const api=async(path,epoch,body)=>{calls.push({path,body});if(hold){const gate=hold;hold=undefined;await gate;}return structuredClone(response);};
  const ui=createNativeModelReview({document:{querySelector:$,querySelectorAll:()=>[]},api,run,isBusy:()=>busy,getPrincipal:()=>p,
    onSubmit:c=>{submitted.push(c);return true;},onHistory:()=>{},newKey:()=> 'explicit-human-decision'});ui.render();
  const choose=()=>{$('#model-review-choice').value=option.optionKey;$('#model-review-choice').onchange();};
  const submit=(decision='APPROVE',reason='independently checked')=>{$('#model-review-decision').value=decision;$('#model-review-reason').value=reason;$('#model-review-confirm').checked=true;$('#model-review-submit').onsubmit({preventDefault(){}});};
  return {ui,$,calls,submitted,response,option,choose,submit,error:()=>error,html:()=>$('#model-review').innerHTML,hold:v=>hold=v,setActor:v=>p=v};
}

test('owner picker shows actual fields and read-only metrics, escapes content, and requires a reason and explicit choice',async()=>{
  const f=fixture();await f.ui.load();f.choose();assert.match(f.html(),/&lt;img/);assert.doesNotMatch(f.html(),/<img/);assert.match(f.html(),/candidate.meanNll/);assert.match(f.html(),/NOT_CHECKED/);
  f.submit('','reason');f.submit('APPROVE','');assert.equal(f.submitted.length,0);f.submit();f.submit();assert.equal(f.submitted.length,1);
  assert.deepEqual(f.submitted[0],{mode:'DECIDE',input:{...f.option.command,requestKey:'explicit-human-decision',decision:'APPROVE',reason:'independently checked'}});
  assert.ok(f.calls.every(c=>c.path==='/learning/decision-jobs/options'&&c.body===undefined));
});

test('recorded regression cannot be approved; explicit rejection remains possible and unavailable evidence cannot submit',async()=>{
  const f=fixture();f.option.score.result.decision='REJECT_REGRESSION';f.option.approvalUnavailableReasons=['REJECT_REGRESSION'];await f.ui.load();f.choose();
  f.submit('APPROVE');assert.equal(f.submitted.length,0);f.submit('REJECT');assert.equal(f.submitted[0].input.decision,'REJECT');
  const g=fixture();g.option.command=null;g.option.unavailableReasons=['PROTOCOL_CHANGED'];await g.ui.load();g.choose();assert.doesNotMatch(g.html(),/id="model-review-submit"/);
});

test('fabricated readiness and misbound commands fail closed instead of offering an approval form',async()=>{
  for(const mutate of [f=>f.response.predictionReady=true,f=>f.option.qualification='READY',f=>f.option.command.evaluationId='other',f=>f.option.score.result.decision='PASS']){
    const f=fixture();mutate(f);await f.ui.load();assert.match(f.error().message,/INVALID_MODEL_REVIEW_OPTIONS/);assert.doesNotMatch(f.html(),/id="model-review-submit"/);
  }
});

test('changed identity discards late evidence and old selections never authorize new submissions',async()=>{
  const f=fixture();let release;f.hold(new Promise(r=>release=r));const pending=f.ui.load();f.setActor({id:'other',tenantId:'native',roles:['model_owner']});release();await pending;
  assert.equal(f.error().discarded,true);assert.doesNotMatch(f.html(),/id="model-review-choice"/);
  const g=fixture();await g.ui.load();g.choose();g.setActor({id:'viewer',tenantId:'native',roles:['viewer']});g.submit();assert.equal(g.submitted.length,0);
});

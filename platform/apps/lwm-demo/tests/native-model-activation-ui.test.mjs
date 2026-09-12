import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeModelActivation} from '../public-plus/native-model-activation-ui.js';

// Shipped UI handlers, explicit DOM and directory adapters, not browser QA.
function fixture({version=0}={}){
  const nodes=new Map(),$=s=>{if(!nodes.has(s))nodes.set(s,{});return nodes.get(s);};let html='',last=Promise.resolve(),busy=false,error,hold,corrupt=false,accepted=true;
  let p={id:'owner',tenantId:'native',roles:['model_owner']};const commands=[],calls=[],reference={id:'release',version:1,hash:'a'.repeat(64)};
  const item={id:'decision',version:1,contentHash:'b'.repeat(64),decision:'APPROVE',recordedReadiness:'READY',revoked:false,createdAt:'2026-01-01T00:00:00.000Z',release:reference,evaluation:{...reference,id:'evaluation'},configuredPolicyMatches:true,qualification:'NOT_CHECKED'};
  Object.defineProperty($('#model-activation'),'innerHTML',{get:()=>html,set:v=>html=v});
  const api=async(path)=>{calls.push(path);if(hold){const gate=hold;hold=undefined;await gate;}
    if(path==='/learning/deployments')return {schema:'plus-model-selection-index-v1',items:[{key:'task.model',qualification:'NOT_CHECKED',recordedSelection:version?{version}:null}],readOnly:true,predictionReady:false,executionAuthorized:false};
    return {schema:'plus-model-decision-selection-index-v1',key:'task.model',policyHash:'c'.repeat(64),items:[{...item,qualification:corrupt?'READY':'NOT_CHECKED'},
      {...item,id:'revoked',revoked:true},{...item,id:'rejected',decision:'REJECT'},{...item,id:'mismatch',configuredPolicyMatches:false}],readOnly:true,predictionReady:false,modelDeploymentAuthorized:false};};
  const run=fn=>{busy=true;last=fn(1).catch(e=>error=e).finally(()=>busy=false);return last;};
  const ui=createNativeModelActivation({document:{querySelector:$},api,run,isBusy:()=>busy,getPrincipal:()=>p,newKey:()=> 'stable-request-key',onSubmit:v=>{commands.push(v);return accepted;}});ui.render();
  return {ui,$,commands,calls,html:()=>html,error:()=>error,hold:v=>hold=v,corrupt:()=>corrupt=true,accept:v=>accepted=v,setActor:v=>p=v,
    choose:(id='decision')=>{$('#model-activation-decision').value=id;$('#model-activation-decision').onchange();},
    submit:(reason='Publish approved candidate',confirm=true)=>{$('#model-activation-reason').value=reason;$('#model-activation-confirm').checked=confirm;$('#model-activation-form').onsubmit({preventDefault(){}});}};
}
test('first activation and replacement use exact current native version and approved decision reference, never raw JSON or direct switching',async()=>{
  for(const version of [0,4]){const f=fixture({version});await f.ui.load('task.model');f.choose();f.submit('',false);assert.equal(f.commands.length,0);
    f.submit();assert.deepEqual(f.commands[0],{mode:'ACTIVATE',input:{key:'task.model',expectedVersion:version,decisionId:'decision',requestKey:'stable-request-key',reason:'Publish approved candidate'}});
    assert.deepEqual(f.calls,['/learning/deployments','/learning/model-decisions?key=task.model']);assert.match(f.html(),/不代表模型已生效/);
  }
});
test('rejected, revoked and mismatched rows cannot be selected; a blocked job handoff retains the original command',async()=>{
  const f=fixture();await f.ui.load('task.model');for(const id of ['revoked','rejected','mismatch']){f.choose(id);assert.doesNotMatch(f.html(),/id="model-activation-form"/);}
  f.choose();f.accept(false);f.submit();f.submit('Do not change a pending intention');assert.deepEqual(f.commands[0],f.commands[1]);
  await f.ui.load('other');assert.equal(f.calls.length,2);
});
test('forged eligibility, changed identities and late responses cannot become activation choices',async()=>{
  const f=fixture();f.corrupt();await f.ui.load('task.model');assert.match(f.html(),/INVALID_MODEL_ACTIVATION_INDEX/);
  const g=fixture();let release;g.hold(new Promise(r=>release=r));const loading=g.ui.load('task.model');g.ui.reset();g.ui.render();release();await loading;
  assert.equal(g.error().discarded,true);assert.doesNotMatch(g.html(),/id="model-activation-form"/);
  const h=fixture();await h.ui.load('task.model');h.setActor({id:'viewer',tenantId:'native',roles:['viewer']});h.ui.render();assert.doesNotMatch(h.html(),/id="model-activation-form"/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeEvaluationWorkbench} from '../public-plus/native-evaluation-ui.js';

// Shipped handlers with explicit DOM/API adapters, not browser or model proof.
function fixture(){const nodes=new Map(),$=s=>{if(!nodes.has(s))nodes.set(s,{});return nodes.get(s);};
  let busy=false,last=Promise.resolve(),error,hold,keyCalls=0,accepted=true,p={id:'trainer',tenantId:'native',roles:['trainer']},execution={datasetId:'train',executionId:'fit'};
  const command={key:'score.task',protocolId:'protocol',executionId:'fit',validationDatasetIds:['validation-a','validation-b']};
  const option={optionKey:'a'.repeat(64),key:'score.task',protocol:{id:'protocol',version:2,revision:1,status:'APPROVED',readiness:'READY',contentHash:'b'.repeat(64)},
    evaluatorId:'<img onerror=x>',classification:'SYNTHETIC',recordedAvailable:true,unavailableReasons:[],command,qualification:'NOT_CHECKED'};
  const response={schema:'plus-evaluation-submission-options-v1',datasetId:'train',executionId:'fit',keys:['score.task'],items:[option],readOnly:true,evaluationAuthorized:false,predictionReady:false,executionAuthorized:false};
  const calls=[],submitted=[],api=async(path,epoch,body)=>{calls.push({path,body});if(hold){const gate=hold;hold=undefined;await gate;}return structuredClone(response);};
  const run=fn=>{busy=true;last=fn(1).catch(e=>error=e).finally(()=>busy=false);return last;};
  const ui=createNativeEvaluationWorkbench({document:{querySelector:$,querySelectorAll:()=>[]},api,run,isBusy:()=>busy,getPrincipal:()=>p,getExecution:()=>execution,
    onSubmit:c=>{submitted.push(c);return accepted;},onHistory:()=>{},newKey:()=>{keyCalls++;return 'original-evaluation-request';}});ui.render();
  const choose=()=>{$('#evaluation-option').value=option.optionKey;$('#evaluation-option').onchange();};
  const submit=()=>{$('#evaluation-confirm').checked=true;$('#evaluation-submit').onsubmit({preventDefault(){}});};
  return {ui,$,calls,submitted,response,option,choose,submit,settle:()=>last,error:()=>error,html:()=>$('#evaluation-workbench').innerHTML,keyCalls:()=>keyCalls,
    hold:v=>hold=v,setActor:v=>p=v,setExecution:v=>execution=v,deny:()=>accepted=false};
}
test('picker chooses exact native protocol and full dataset group, escapes labels, and retains intent when handoff is blocked',async()=>{
  const f=fixture();assert.equal(f.calls.length,0);await f.ui.load();assert.match(f.html(),/&lt;img/);assert.doesNotMatch(f.html(),/<img/);
  f.choose();f.deny();f.submit();f.submit();assert.equal(f.keyCalls(),1);assert.deepEqual(f.submitted[0],f.submitted[1]);
  assert.deepEqual(f.submitted[0],{mode:'EVALUATE',input:{...f.option.command,requestKey:'original-evaluation-request'}});
  assert.match(f.html(),/保留原意图/);assert.ok(f.calls.every(c=>c.body===undefined));
});
test('picker cannot select unavailable or incomplete option and rejects forged current qualification',async()=>{
  const f=fixture();f.option.recordedAvailable=false;f.option.unavailableReasons=['VALIDATION_NOT_FROZEN'];f.option.command=null;
  await f.ui.load();f.choose();assert.doesNotMatch(f.html(),/id="evaluation-submit"/);assert.equal(f.submitted.length,0);
  const g=fixture();g.option.qualification='READY';await g.ui.load();assert.match(g.error().message,/INVALID_EVALUATION_OPTIONS/);
  const h=fixture();h.option.command.validationDatasetIds=[];await h.ui.load();assert.match(h.error().message,/INVALID_EVALUATION_OPTIONS/);
});
test('picker discards late options after training context or identity changes and never posts for non-trainer',async()=>{
  const f=fixture();let release;f.hold(new Promise(r=>release=r));const pending=f.ui.load();f.setExecution({datasetId:'other',executionId:'different'});release();await pending;
  assert.equal(f.error().discarded,true);assert.doesNotMatch(f.html(),/id="evaluation-option"/);
  const g=fixture();g.setActor({id:'viewer',tenantId:'native',roles:['viewer']});g.ui.render();await g.ui.load();assert.equal(g.calls.length,0);
  const h=fixture();await h.ui.load();h.choose();h.setActor({id:'other',tenantId:'native',roles:['trainer']});h.submit();assert.equal(h.submitted.length,0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeIntakeWorkbench} from '../public-plus/native-intake-ui.js';
import {matterIntakeFields} from '../public-plus/native-intake.js';
function fixture(){
  const nodes=new Map(),$=key=>{if(!nodes.has(key))nodes.set(key,{value:'',disabled:false});return nodes.get(key);};
  const catalog={bundle:{contentHash:'schema-1',manifests:{NativeImportTaskMatter:{},NativeRegisterInvestigationTask:{}},disabledActions:[],parsed:{enums:[{name:'RiskBand',values:[{name:'LOW'}]}]}}};
  let last=Promise.resolve(),busy=false,html='',error,opened,lose=false,block;const calls=[];
  const api=async(path,epoch,body,key)=>{calls.push({path,body,key});if(path==='/ontology')return catalog;if(block)await new Promise(r=>block=r);if(lose){lose=false;throw Object.assign(Error('response lost'),{status:502});}return {success:true,receipt:{_id:'receipt',actionName:'NativeImportTaskMatter',resultType:'Matter',resultId:'matter'}};};
  const run=fn=>{busy=true;last=fn(1).catch(e=>error=e).finally(()=>busy=false);return last;};
  const render=()=>{html=ui.markup();ui.bind();};
  const ui=createNativeIntakeWorkbench({document:{querySelector:$},api,run,isBusy:()=>busy,getCatalog:()=>catalog,getDetail:()=>null,onOpenObject:async r=>opened=r,onRender:render});render();
  const fill=()=>{const values=['SOURCE-1','<script>alert(1)</script>','TEST','UNASSESSED','LOW','2026-01-01T00:00:00.000Z','demo-matter','record','1'];matterIntakeFields.forEach((f,i)=>$('#intake-MATTER-'+f).value=values[i]);};
  return {$,ui,fill,render,calls,html:()=>html,error:()=>error,opened:()=>opened,settle:()=>last,lose:()=>lose=true,block:()=>block=true,release:()=>block(),submit:()=>$('#intake-MATTER').onsubmit({preventDefault(){}})};
}
test('source form previews escaped frozen values, only explicit confirmation submits, then navigates to returned native Matter',async()=>{
  const f=fixture();f.fill();f.submit();await f.settle();assert.equal(f.calls.length,0);assert.match(f.html(),/&lt;script&gt;/);assert.doesNotMatch(f.html(),/<script>/);
  f.$('#intake-confirm').onclick();await f.settle();assert.equal(f.calls.filter(c=>c.body).length,1);assert.match(f.html(),/原生事务已提交/);f.$('#intake-open').onclick();await f.settle();assert.deepEqual(f.opened(),{type:'Matter',id:'matter'});
});
test('unknown result locks new preflight and preserves the exact request; reset discards a late native response',async()=>{
  const f=fixture();f.fill();f.submit();await f.settle();f.lose();f.$('#intake-confirm').onclick();await f.settle();assert.match(f.html(),/结果未知/);assert.match(f.html(),/<fieldset disabled>/);
  f.$('#intake-MATTER-title').value='changed';f.submit();await f.settle();f.$('#intake-confirm').onclick();await f.settle();const sent=f.calls.filter(c=>c.body);assert.deepEqual(sent[0],sent[1]);
  const late=fixture();late.fill();late.submit();await late.settle();late.block();late.$('#intake-confirm').onclick();await new Promise(r=>setImmediate(r));late.ui.reset();late.render();late.release();await late.settle();assert.equal(late.error().discarded,true);assert.doesNotMatch(late.html(),/回执 receipt|查看 Matter/);
});

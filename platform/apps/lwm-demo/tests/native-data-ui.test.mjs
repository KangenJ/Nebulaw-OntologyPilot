import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeDataWorkbench} from '../public-plus/native-data-ui.js';
import {observationImportFields} from '../public-plus/observation-import.js';

// Explicit DOM/network adapter tests, not browser rendering or native action proof.
function fixture(){
  const nodes=new Map(),buttons=[],$=key=>{
    if(!nodes.has(key)){let html='';const node={value:'',disabled:false,files:[]};Object.defineProperty(node,'innerHTML',{get:()=>html,set:v=>{html=v;if(key==='#content'){buttons.length=0;for(const match of v.matchAll(/data-import-object="(\d+)"/g))buttons.push({dataset:{importObject:match[1]}});}}});nodes.set(key,node);}return nodes.get(key);
  };
  const catalog={bundle:{contentHash:'native-hash',manifests:{NativeRecordTaskObservation:{}},disabledActions:[]}},reference={type:'InvestigationTask',id:'task-1',version:1};
  let detail={reference},last=Promise.resolve(),busy=false,error,deny=false,opened;const calls=[];
  const api=async(path,epoch,body,key)=>{calls.push({path,body:structuredClone(body),key});if(path==='/ontology')return catalog;if(path.startsWith('/objects/'))return {reference};if(deny)throw Object.assign(Error('FORBIDDEN'),{status:403});return {success:true,receipt:{_id:'receipt-1',actionName:'NativeRecordTaskObservation',resultType:'Observation',resultId:'obs-1'},event:{id:'event-1'}};};
  const run=fn=>{if(busy)return;busy=true;last=fn(1).catch(e=>error=e).finally(()=>busy=false);return last;};
  const ui=createNativeDataWorkbench({document:{querySelector:$,querySelectorAll:()=>buttons},api,run,isBusy:()=>busy,getCatalog:()=>catalog,getDetail:()=>detail,onOpenObject:async ref=>{opened=ref;}});ui.render();
  const file=async(text)=>{$('#import-file').files=[{name:'<img onerror=x>.json',size:text.length,text:async()=>text}];$('#import-file').onchange();await last;};
  const preflight=async()=>{for(const field of observationImportFields)$('#import-map-'+field).value=field;$('#import-source').value='trusted-source';$('#import-channel').value='report';$('#import-map').onsubmit({preventDefault(){}});await last;};
  return {$,ui,calls,buttons,file,preflight,settle:()=>last,error:()=>error,opened:()=>opened,deny:()=>deny=true,unselect:()=>detail=null};
}
const source=()=>JSON.stringify([{title:'<script>alert(1)</script>',summary:'new data',reportedCompletion:'DONE',eventTime:'2026-09-01T00:00:00Z',sourceRecordId:'source-a',sourceRevision:'1'}]);

test('file → mapping → read-only preflight → explicit native submission → object navigation',async()=>{
  const f=fixture();await f.file(source());assert.equal(f.calls.length,0);await f.preflight();assert.equal(f.calls.length,0,'no implicit writes or approval');
  assert.match(f.$('#content').innerHTML,/&lt;script&gt;/);assert.doesNotMatch(f.$('#content').innerHTML,/<script>|<img/);
  f.$('#import-confirm').onclick();await f.settle();assert.equal(f.calls.filter(c=>c.body).length,1);assert.match(f.$('#content').innerHTML,/已写入/);
  assert.match(f.$('#content').innerHTML,/receipt-1/);f.buttons[0].onclick();await f.settle();assert.deepEqual(f.opened(),{type:'Observation',id:'obs-1'});
});
test('changed mapping invalidates confirmation; known permission refusal leaves no false receipt',async()=>{
  const f=fixture();await f.file(source());await f.preflight();f.$('#import-source').value='changed';f.$('#import-source').oninput();assert.equal(f.$('#import-confirm').disabled,true);
  const count=f.calls.length;f.$('#import-confirm').onclick();await f.settle();assert.equal(f.calls.length,count);
  await f.preflight();f.deny();f.$('#import-confirm').onclick();await f.settle();assert.match(f.$('#content').innerHTML,/失败并停止/);assert.doesNotMatch(f.$('#content').innerHTML,/receipt-1/);
});
test('reset during local file read prevents credentials-session data reappearance; task required',async()=>{
  const f=fixture();let release;f.$('#import-file').files=[{name:'late.json',size:20,text:()=>new Promise(resolve=>release=resolve)}];
  f.$('#import-file').onchange();f.ui.reset();f.unselect();f.ui.render();release(source());await f.settle();
  assert.equal(f.error().discarded,true);assert.doesNotMatch(f.$('#content').innerHTML,/late.json|import-map/);assert.match(f.$('#content').innerHTML,/id="import-file"[^>]*disabled/);assert.equal(f.calls.length,0);
});

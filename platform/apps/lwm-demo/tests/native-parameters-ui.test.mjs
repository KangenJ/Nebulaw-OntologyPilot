import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeParameterView} from '../public-plus/native-parameters-ui.js';

// Explicit display/network adapter, not browser/native compilation evidence.
function fixture(){
  const nodes=new Map(),buttons=[],$=key=>{if(!nodes.has(key))nodes.set(key,{});return nodes.get(key);};
  let html='',last=Promise.resolve(),busy=false,error,denied=false,hold;const calls=[];
  const manifest={schema:'plus-parameter-manifest-v1',definition:{key:'task.example',title:'<img onerror=x>',revision:1,reference:{id:'native-definition',version:3}},ontology:{compiledAtSchemaRevision:'old',currentSchemaRevision:'current'},policyHash:'policy',currentPolicyHash:'current-policy',contentHash:'manifest',readOnly:true,predictionReady:false,executionAuthorized:false,
    variables:[{key:'state',role:'LATENT',source:{objectType:'Task',field:'actual'},sourceType:{name:'Completion'},valueType:'Completion',support:['DONE','NOT_DONE'],unknownValues:['UNKNOWN'],time:{eventTimeField:'at',receivedTimeField:'receivedAt'},missingPolicy:{null:'MISSING'},verification:{mode:'GOLD'},unit:'1'}],layout:{jointStateCount:2},moduleOrder:['transition'],modules:[{key:'transition',inputs:['state']}],actions:[],budget:{},utility:{},scope:{}};
  const api=async(path)=>{calls.push(path);if(hold){const wait=hold;hold=undefined;await wait;}if(denied)throw Error('DEFINITION_FORBIDDEN');return path==='/definitions'?{readOnly:true,items:[{key:'task.example',rootType:'Task',revision:1,status:'PUBLISHED'},{key:'not.ready',status:'DRAFT'}]}:structuredClone(manifest);};
  const run=fn=>{if(busy)return;busy=true;last=fn(1).catch(e=>error=e).finally(()=>busy=false);return last;};
  const render=()=>{html=ui.markup();buttons.length=0;for(const match of html.matchAll(/data-parameter-key="([^"]+)"/g))buttons.push({dataset:{parameterKey:match[1]}});ui.bind();};
  const ui=createNativeParameterView({document:{querySelector:$,querySelectorAll:()=>buttons},api,run,isBusy:()=>busy,onRender:render});render();
  return {$,ui,buttons,calls,html:()=>html,render,settle:()=>last,error:()=>error,deny:()=>denied=true,hold:p=>hold=p};
}
test('native mechanism index allows selection without manual IDs and renders a read-only parameter contract with escaped content',async()=>{
  const f=fixture();assert.equal(f.calls.length,0);f.$('#parameters-refresh').onclick();await f.settle();
  f.buttons.find(b=>b.dataset.parameterKey==='not.ready').onclick();await f.settle();assert.equal(f.calls.length,1);
  f.buttons[0].onclick();await f.settle();assert.deepEqual(f.calls,['/definitions','/definitions/task.example/parameters']);
  assert.match(f.html(),/&lt;img/);assert.doesNotMatch(f.html(),/<img/);assert.match(f.html(),/不是网络参数量/);assert.match(f.html(),/compiledAtSchemaRevision/);
});
test('failed current read clears old manifest and a reset during discovery cannot repopulate prior identity data',async()=>{
  const f=fixture();f.$('#parameters-refresh').onclick();await f.settle();f.buttons[0].onclick();await f.settle();f.deny();f.buttons[0].onclick();await f.settle();
  assert.match(f.html(),/DEFINITION_FORBIDDEN/);assert.doesNotMatch(f.html(),/native-definition|&lt;img/);
  const other=fixture();let release;other.hold(new Promise(resolve=>release=resolve));other.$('#parameters-refresh').onclick();other.ui.reset();other.render();release();await other.settle();
  assert.equal(other.error().discarded,true);assert.doesNotMatch(other.html(),/task.example/);
});

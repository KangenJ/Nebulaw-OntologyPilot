import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeLinksView} from '../public-plus/native-links-ui.js';

// Explicit DOM/network adapter; actual native relation/read tests are separate.
function fixture(){
  const nodes=new Map(),buttons=[],$=key=>{if(!nodes.has(key))nodes.set(key,{value:''});return nodes.get(key);};
  let detail={reference:{type:'Task',id:'root',version:1}},html='',last=Promise.resolve(),busy=false,error,fail=false,hold,rootVersion=1,opened;const calls=[];
  const catalog={bundle:{parsed:{linkTypes:[{name:'TaskReport',from:'Task',to:'Report'}]}}};
  const api=async(path)=>{calls.push(path);if(hold){const wait=hold;hold=undefined;await wait;}if(fail)throw Error('OBJECT_LINK_FORBIDDEN');const second=path.includes('after=edge-a');return {root:{type:'Task',id:'root',version:rootVersion},linkType:'TaskReport',direction:'outbound',readOnly:true,hasMore:!second,nextAfter:second?null:'edge-a',items:[{link:{_id:second?'edge-b':'edge-a',_version:1,_type:'TaskReport',_fromType:'Task',_toType:'Report'},neighbor:{reference:{type:'Report',id:second?'b':'a',version:1},object:{title:'<img onerror=x>'}}}]};};
  const run=fn=>{if(busy)return;busy=true;last=fn(1).catch(e=>error=e).finally(()=>busy=false);return last;};
  const render=()=>{html=ui.markup();buttons.length=0;for(const match of html.matchAll(/data-linked-object="(\d+)"/g))buttons.push({dataset:{linkedObject:match[1]}});ui.bind();};
  const ui=createNativeLinksView({document:{querySelector:$,querySelectorAll:()=>buttons},api,run,isBusy:()=>busy,getCatalog:()=>catalog,getDetail:()=>detail,onRender:render,onOpenObject:async ref=>{opened=ref;}});render();
  const query=async()=>{$('#links-choice').value='TaskReport:outbound';$('#links-query').onsubmit({preventDefault(){}});await last;};
  return {$,ui,buttons,calls,query,render,html:()=>html,settle:()=>last,error:()=>error,deny:()=>fail=true,hold:p=>hold=p,clear:()=>detail=null,version:v=>rootVersion=v,opened:()=>opened};
}
test('relationship UI queries native selected type/direction, pages visible edges, escapes attributes and opens actual neighbor reference',async()=>{
  const f=fixture();assert.equal(f.calls.length,0);await f.query();assert.equal(f.calls[0],'/objects/Task/root/links?linkType=TaskReport&direction=outbound&limit=25');
  assert.match(f.html(),/&lt;img/);assert.doesNotMatch(f.html(),/<img/);f.$('#links-next').onclick();await f.settle();assert.match(f.calls.at(-1),/after=edge-a/);
  f.buttons[0].onclick();await f.settle();assert.deepEqual(f.opened(),{type:'Report',id:'b',version:1});f.$('#links-prev').onclick();await f.settle();assert.doesNotMatch(f.calls.at(-1),/after=/);
});
test('relationship UI clears a failed page and refuses a current graph under an old root detail version',async()=>{
  const f=fixture();await f.query();f.deny();await f.query();assert.match(f.html(),/OBJECT_LINK_FORBIDDEN/);assert.doesNotMatch(f.html(),/edge-a|&lt;img/);
  const changed=fixture();changed.version(2);await changed.query();assert.match(changed.html(),/根对象版本已变化/);assert.doesNotMatch(changed.html(),/edge-a/);
});
test('logout/reset during link read cannot repopulate the previous object graph',async()=>{
  const f=fixture();let release;f.hold(new Promise(resolve=>release=resolve));const request=f.query();f.ui.reset();f.clear();f.render();release();await request;
  assert.equal(f.error().discarded,true);assert.equal(f.html(),'');
});

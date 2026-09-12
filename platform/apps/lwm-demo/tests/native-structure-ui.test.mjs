import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeStructureWorkbench} from '../public-plus/native-structure-ui.js';
// Small explicit DOM/HTTP adapter, not browser or real publication evidence.
function fixture({existing=false}={}){
  const nodes=new Map(),objects=[],links=[],calls=[];let html='',last=Promise.resolve(),error,preview=null,invalidations=0;
  const catalog={bundle:{contentHash:'original',parsed:{objectTypes:[{name:'Matter',fields:[]},...(existing?[{name:'Deliverable',fields:[{name:'title'}]}]:[])]}}};
  const $=id=>nodes.get(id);let ui;
  const render=()=>{html=ui.markup();nodes.clear();objects.length=0;links.length=0;
    for(const match of html.matchAll(/<(?:input|select|form|button)\b([^>]*\bid="([^"]+)"[^>]*)>/g)){
      const attrs=match[1],id=match[2],tail=html.slice(match.index+match[0].length),select=match[0].startsWith('<select');
      const selected=select?tail.split('</select>')[0].match(/<option value="([^"]*)" selected/):null;
      nodes.set('#'+id,{value:selected?.[1]??attrs.match(/\bvalue="([^"]*)"/)?.[1]??'',checked:/\bchecked\b/.test(attrs),disabled:/\bdisabled\b/.test(attrs),files:[]});
    }
    for(const [key,target] of [['object',objects],['link',links]])for(const m of html.matchAll(new RegExp('data-structure-'+key+'="([^"]+)"','g')))target.push({dataset:{[key==='object'?'structureObject':'structureLink']:m[1]}});
    ui.bind();
  };
  const run=fn=>last=Promise.resolve().then(()=>fn(1)).catch(e=>{error=e;});
  ui=createNativeStructureWorkbench({document:{querySelector:$,querySelectorAll:s=>s==='[data-structure-object]'?objects:s==='[data-structure-link]'?links:[]},
    api:async(path,epoch,body)=>{calls.push({path,body});return {readOnly:true,source:{},expectedParentHash:body.expectedParentHash};},run,isBusy:()=>false,getCatalog:()=>catalog,getPrincipal:()=>({roles:['data_reviewer']}),
    onRender:render,onPreview:v=>preview=v,onInvalidate:()=>{preview=null;invalidations++;}});render();
  const upload=async(text=JSON.stringify({Deliverable:[{title:'private-data',matterId:'private-ref'}]}))=>{$('#structure-file').files=[{size:text.length,text:async()=>text}];$('#structure-file').onchange();await last;};
  return {$,ui,catalog,objects,links,calls,upload,settle:()=>last,error:()=>error,html:()=>html,preview:()=>preview,invalidations:()=>invalidations};
}
test('collection assistance permits field edit/removal then only requests readonly native preview, never publishes or uploads values',async()=>{
  const f=fixture();await f.upload();assert.equal(f.error(),undefined);assert.equal(f.calls.length,0);assert.doesNotMatch(f.html(),/private-data|private-ref/);
  f.objects[0].onclick();f.$('#structure-name').value='ReviewedDeliverable';f.$('#structure-field-0').value='reviewedTitle';f.$('#structure-form').oninput();
  f.$('#structure-form').onsubmit({preventDefault(){}});await f.settle();assert.equal(f.calls.length,1);
  assert.deepEqual(f.calls[0],{path:'/ontology/structure-previews',body:{kind:'OBJECT',name:'ReviewedDeliverable',expectedParentHash:'original',properties:[{name:'reviewedTitle',valueType:'String'}]}});
  assert.equal(f.preview().readOnly,true);f.$('#structure-discard').onclick();assert.equal(f.preview(),null);assert.doesNotMatch(f.html(),/structure-form/);
});
test('relationship suggestion requires explicit direction/cardinality confirmation and stale ontology cannot submit',async()=>{
  const f=fixture({existing:true});await f.upload();f.links[0].onclick();f.$('#structure-form').onsubmit({preventDefault(){}});await f.settle();
  assert.equal(f.calls.length,0);assert.match(f.error().message,/确认/);
  f.$('#structure-from').value='Matter';f.$('#structure-to').value='Deliverable';f.$('#structure-cardinality').value='ONE_TO_MANY';f.$('#structure-confirm').checked=true;
  f.$('#structure-form').onsubmit({preventDefault(){}});await f.settle();assert.equal(f.calls[0].body.from,'Matter');assert.equal(f.calls[0].body.cardinality,'ONE_TO_MANY');
  f.catalog.bundle.contentHash='changed';f.$('#structure-form').onsubmit({preventDefault(){}});await f.settle();assert.equal(f.calls.length,1);assert.equal(f.preview(),null);assert.match(f.error().message,/STALE/);
});
test('late sample after session reset cannot restore prior identity material',async()=>{
  const f=fixture();let finish;f.$('#structure-file').files=[{size:50,text:()=>new Promise(r=>finish=r)}];f.$('#structure-file').onchange();
  await Promise.resolve();f.ui.reset();finish('{"Deliverable":[{"title":"private"}]}');await f.settle();assert.equal(f.error().discarded,true);assert.equal(f.calls.length,0);assert.equal(f.objects.length,0);
});

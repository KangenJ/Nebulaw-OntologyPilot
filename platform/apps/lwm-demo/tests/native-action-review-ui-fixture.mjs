import {createNativeActionReviewWorkbench} from '../public-plus/native-action-review-ui.js';

// Explicit minimal DOM; invokes shipped handlers, not browser/layout evidence.
export function reviewUiFixture({api,principal,detail=null,saved=new Map()}){
  let html='',nodes=new Map(),busy=false,last=Promise.resolve(),error,p=principal,root=detail,deny=false;
  const content={};Object.defineProperty(content,'innerHTML',{get:()=>html,set:value=>{html=value;nodes=new Map([['#content',content]]);
    for(const m of value.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g))nodes.set('#'+m[1],{value:'',checked:false});}});nodes.set('#content',content);
  const document={querySelector:s=>nodes.get(s)??null};const storage={getItem:k=>saved.get(k)??null,setItem:(k,v)=>{if(deny)throw Error('quota');saved.set(k,v);},removeItem:k=>saved.delete(k)};
  const run=fn=>{if(busy)return;busy=true;last=fn(1).catch(e=>error=e).finally(()=>busy=false);return last;};
  const ui=createNativeActionReviewWorkbench({document,api,run,isBusy:()=>busy,getPrincipal:()=>p,getDetail:()=>root,getStorage:()=>storage});ui.render();const $=s=>document.querySelector(s);
  return {ui,$,saved,html:()=>html,settle:()=>last,error:()=>error,setActor:v=>p=v,setDetail:v=>root=v,denyStorage:()=>deny=true,
    choose:key=>{$('#action-review-select').value=key;$('#action-review-select').onchange();},
    decide:(decision='APPROVE',reason='Independent review',confirmed=true)=>{$('#action-review-decision').value=decision;$('#action-review-reason').value=reason;$('#action-review-confirm').checked=confirmed;$('#action-review-form').onsubmit({preventDefault(){}});}};
}

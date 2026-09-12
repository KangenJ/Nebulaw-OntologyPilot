import {createNativeActionProposalWorkbench} from '../public-plus/native-action-proposal-ui.js';
// Explicit minimal DOM adapter; not browser/layout certification.
export function proposalUiFixture({api,principal,detail=null,saved=new Map(),requestKey=()=> 'ui-native-proposal'}){
  let html='',nodes=new Map(),busy=false,last=Promise.resolve(),error,p=principal,root=detail,deny=false;
  const content={};Object.defineProperty(content,'innerHTML',{get:()=>html,set:v=>{html=v;nodes=new Map([['#content',content]]);for(const m of v.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g))nodes.set('#'+m[1],{value:'',checked:false});}});nodes.set('#content',content);
  const document={querySelector:s=>nodes.get(s)??null},storage={getItem:k=>saved.get(k)??null,setItem:(k,v)=>{if(deny)throw Error('quota');saved.set(k,v);},removeItem:k=>saved.delete(k)};
  const run=fn=>{if(busy)return;busy=true;last=fn(1).catch(e=>error=e).finally(()=>busy=false);return last;};
  const ui=createNativeActionProposalWorkbench({document,api,run,isBusy:()=>busy,getPrincipal:()=>p,getDetail:()=>root,getStorage:()=>storage,requestKey});ui.render();const $=s=>document.querySelector(s);
  return {ui,$,saved,html:()=>html,settle:()=>last,error:()=>error,setActor:v=>p=v,setDetail:v=>root=v,denyStorage:()=>deny=true,
    choose:key=>{$('#action-proposal-select').value=key;$('#action-proposal-select').onchange();},
    fill:values=>{for(const [k,v]of Object.entries(values))$('#action-proposal-'+k).value=v;},
    submit:(confirmed=true)=>{$('#action-proposal-confirm').checked=confirmed;$('#action-proposal-form').onsubmit({preventDefault(){}});}};
}

import {createNativeGovernanceWorkbench} from '../public-plus/native-governance-ui.js';
// Shipped handlers, explicit DOM adapter: never browser/layout acceptance.
export function governanceUiFixture({api,principal,detail}){
  let html='',nodes=new Map(),busy=false,last=Promise.resolve(),error,p=principal,r=detail;
  const content={};Object.defineProperty(content,'innerHTML',{get:()=>html,set:v=>{html=v;nodes=new Map([['#content',content]]);for(const m of v.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g))nodes.set('#'+m[1],{value:''});}});nodes.set('#content',content);
  const document={querySelector:s=>nodes.get(s)??null},run=fn=>{if(busy)return;busy=true;last=fn(1).catch(e=>error=e).finally(()=>busy=false);return last;};
  const ui=createNativeGovernanceWorkbench({document,api,run,isBusy:()=>busy,getPrincipal:()=>p,getDetail:()=>r});ui.render();const $=s=>document.querySelector(s);
  return {ui,$,html:()=>html,settle:()=>last,error:()=>error,setActor:v=>p=v,setDetail:v=>r=v,choose:m=>{$('#governance-mode').value=m;$('#governance-mode').onchange();}};
}

import {createNativeScenarioWorkbench} from '../public-plus/native-scenarios-ui.js';
// Explicit DOM fixture: runs shipped handlers, not layout/browser certification.
export function scenarioUiFixture({api,principal,detail,saved=new Map(),onGoActions=()=>{}}){
  let html='',nodes=new Map(),busy=false,last=Promise.resolve(),error,p=principal,root=detail,deny=false,sequence=0;
  const content={};Object.defineProperty(content,'innerHTML',{get:()=>html,set:v=>{html=v;nodes=new Map([['#content',content]]);for(const m of v.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g))nodes.set('#'+m[1],{value:'',checked:false});}});nodes.set('#content',content);
  const document={querySelector:s=>nodes.get(s)??null},storage={getItem:k=>saved.get(k)??null,setItem:(k,v)=>{if(deny)throw Error('quota');saved.set(k,v);},removeItem:k=>saved.delete(k)};
  const run=fn=>{if(busy)return;busy=true;last=fn(1).catch(e=>error=e).finally(()=>busy=false);return last;};
  const ui=createNativeScenarioWorkbench({document,api,run,isBusy:()=>busy,getPrincipal:()=>p,getDetail:()=>root,getStorage:()=>storage,requestKey:()=> 'ui-native-scenario-'+(++sequence),onGoActions});ui.render();const $=s=>document.querySelector(s);
  return {ui,$,saved,html:()=>html,settle:()=>last,error:()=>error,setActor:v=>p=v,setDetail:v=>root=v,denyStorage:()=>deny=true,
    choose:key=>{$('#scenario-choice').value=key;$('#scenario-choice').onchange();},
    submit:(value,confirmed=true)=>{$('#scenario-availability').value=String(value);$('#scenario-confirm').checked=confirmed;$('#scenario-form').onsubmit({preventDefault(){}});}};
}

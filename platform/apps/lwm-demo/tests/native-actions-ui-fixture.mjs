import {createNativeActionWorkbench} from '../public-plus/native-actions-ui.js';

// Small explicit DOM adapter executing shipped handlers, not a browser claim.
export function actionUiFixture({api,principal,detail=null,saved=new Map(),requestKey=()=> 'ui-original-action'}={}){
  let html='',nodes=new Map(),buttons=[],busy=false,last=Promise.resolve(),error,denyStorage=false,p=principal,root=detail;
  const content={};Object.defineProperty(content,'innerHTML',{get:()=>html,set:value=>{
    html=value;nodes=new Map([['#content',content]]);buttons=[];
    for(const match of value.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g))nodes.set('#'+match[1],{value:'',checked:false});
    for(const match of value.matchAll(/<button[^>]+data-(action-history-key|action-job-id)="([^"]+)"[^>]*>/g)){
      const property=match[1].replace(/-([a-z])/g,(_,c)=>c.toUpperCase());buttons.push({selector:'[data-'+match[1]+']',dataset:{[property]:match[2]}});
    }
  }});nodes.set('#content',content);
  const document={querySelector:s=>nodes.get(s)??null,querySelectorAll:s=>buttons.filter(b=>b.selector===s)};
  const storage={getItem:k=>saved.get(k)??null,setItem:(k,v)=>{if(denyStorage)throw Error('quota');saved.set(k,v);},removeItem:k=>saved.delete(k)};
  const run=fn=>{if(busy)return;busy=true;last=fn(1).catch(e=>error=e).finally(()=>busy=false);return last;};
  const ui=createNativeActionWorkbench({document,api,run,isBusy:()=>busy,getPrincipal:()=>p,getDetail:()=>root,getStorage:()=>storage,requestKey});ui.render();
  const $=s=>document.querySelector(s);
  return {ui,document,$,saved,html:()=>html,settle:()=>last,error:()=>error,setActor:v=>p=v,setDetail:v=>root=v,denyStorage:()=>denyStorage=true,
    choose:option=>{$('#action-request-select').value=option;$('#action-request-select').onchange();},
    execute:(confirmed=true)=>{$('#action-execute-confirm').checked=confirmed;$('#action-execute-form').onsubmit({preventDefault(){}});},
    cancel:()=>{$('#action-cancel-confirm').checked=true;$('#action-cancel-form').onsubmit({preventDefault(){}});}};
}

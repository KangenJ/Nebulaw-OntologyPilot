import {createNativeAnalysisWorkbench} from '../public-plus/native-analysis-ui.js';

// Explicit minimal DOM adapter running shipped handlers, not a browser.
export function analysisUiFixture({api,principal,detail,catalog,onOpenObject=async()=>{}}){
  let html='',nodes=new Map(),buttons=[],busy=false,last=Promise.resolve(),error,p=principal,root=detail;
  const content={};Object.defineProperty(content,'innerHTML',{get:()=>html,set:value=>{
    html=value;nodes=new Map([['#content',content]]);buttons=[];
    for(const m of value.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g))nodes.set('#'+m[1],{value:''});
    for(const m of value.matchAll(/data-analysis-object="([^"]+)"/g))buttons.push({dataset:{analysisObject:m[1]}});
  }});nodes.set('#content',content);
  const document={querySelector:s=>nodes.get(s)??null,querySelectorAll:s=>s==='[data-analysis-object]'?buttons:[]};
  const run=fn=>{if(busy)return;busy=true;last=fn(1).catch(e=>{error=e;}).finally(()=>busy=false);return last;};
  const ui=createNativeAnalysisWorkbench({document,api,run,isBusy:()=>busy,getPrincipal:()=>p,getCatalog:()=>catalog,getDetail:()=>root,onOpenObject});ui.render();
  return {ui,document,$:s=>document.querySelector(s),html:()=>html,settle:()=>last,error:()=>error,setActor:v=>p=v,setDetail:v=>root=v,
    choose:field=>{const n=document.querySelector('#analysis-field');n.value=field;n.onchange();},
    submit:()=>document.querySelector('#analysis-query').onsubmit({preventDefault(){}}),
    parse:text=>{document.querySelector('#analysis-text').value=text;document.querySelector('#analysis-text-form').onsubmit({preventDefault(){}});},
    drill:index=>buttons[index].onclick()};
}

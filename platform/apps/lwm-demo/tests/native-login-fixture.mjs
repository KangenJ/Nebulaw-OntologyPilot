import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { startNativeWorkbench } from '../public-plus/native-workbench.js';

// Minimal DOM adapter executes shipped login handlers. Not a browser/layout
// substitute; request may use real HTTP in the separate canonical host test.
export function loginUiFixture(t,request){
  const nodes=new Map(),node=selector=>{
    if(!nodes.has(selector))nodes.set(selector,{textContent:'',innerHTML:'',value:'',hidden:false,disabled:false,files:[],dataset:{},attributes:{},
      setAttribute(k,v){this.attributes[k]=v;},reset(){node('#login-form input[name=token]').value='';}});
    return nodes.get(selector);
  };
  const document={querySelector:node,querySelectorAll:()=>[]},original=globalThis.FormData;
  for(const selector of ['#login-error','#workspace','#logout'])node(selector).hidden=true;
  globalThis.FormData=class{get(){return node('#login-form input[name=token]').value;}};
  t.after(()=>{globalThis.FormData=original;});
  startNativeWorkbench({document,request});
  const settle=async()=>{for(let i=0;i<1000;i++){if(node('#workspace').attributes['aria-busy']!=='true')return;await delay(5);}assert.fail('Login UI did not settle');};
  return {node,document,settle,async login(token){node('#login-form input[name=token]').value=token;
    node('#login-form').onsubmit({preventDefault(){},currentTarget:node('#login-form')});await settle();},
    logout(){node('#logout').onclick();}};
}

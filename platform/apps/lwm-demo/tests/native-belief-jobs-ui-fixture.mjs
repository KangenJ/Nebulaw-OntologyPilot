import {createNativeBeliefJobs} from '../public-plus/native-belief-jobs-ui.js';

// DOM adapter only. API/context overrides may use a real native HTTP host;
// default contexts are explicit UI contract examples, never model evidence.
export function beliefJobsUiFixture({api:request,getAuthorization,getSnapshot,storage,principal:initialPrincipal}={}){
  const values=new Map(),store=storage??{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
  let html='',last=Promise.resolve(),busy=false,error,principal=initialPrincipal??{tenantId:'tenant',id:'reader',roles:['reader']};
  const nodes=new Map(),container={},calls=[],hash='a'.repeat(64);nodes.set('#belief-jobs',container);
  Object.defineProperty(container,'innerHTML',{get:()=>html,set:v=>{html=v;for(const k of [...nodes.keys()])if(k!=='#belief-jobs')nodes.delete(k);
    for(const m of v.matchAll(/id="([^"]+)"/g))nodes.set('#'+m[1],{checked:false,value:''});}});
  let auth={record:{_id:'authorization',controlKey:'unit.belief'},material:{policy:{clock:{definitionHash:hash,bindingHash:hash}}},replayAuthorized:true,predictionReady:false};
  let snapshot={episodeId:'episode',snapshot:{record:{_id:'snapshot'},compiledInput:{definitionHash:hash,bindingHash:hash}}};
  const run=fn=>{if(busy)return;busy=true;last=fn(1).catch(e=>error=e).finally(()=>busy=false);return last;};
  const ui=createNativeBeliefJobs({document:{querySelector:s=>nodes.get(s)},api:async(...args)=>{calls.push({path:args[0],body:args[2]});return request(...args);},
    run,isBusy:()=>busy,getPrincipal:()=>principal,getAuthorization:getAuthorization??(()=>auth),getSnapshot:getSnapshot??(()=>snapshot),getStorage:()=>store});ui.render();
  const click=async selector=>{nodes.get(selector).onclick();await last;};
  return {ui,calls,storage:store,node:s=>nodes.get(s),html:()=>html,error:()=>error,settle:()=>last,actor:p=>{principal=p;},auth:v=>{auth=v;},snapshot:v=>{snapshot=v;},
    prepare:()=>click('#belief-prepare'),lookup:()=>click('#belief-lookup'),read:()=>click('#belief-read-current'),
    submit:async(confirm=true)=>{nodes.get('#belief-submit-confirm').checked=confirm;nodes.get('#belief-submit-form').onsubmit({preventDefault(){}});await last;},
    cancel:async()=>{nodes.get('#belief-cancel-confirm').checked=true;nodes.get('#belief-cancel-form').onsubmit({preventDefault(){}});await last;}};
}

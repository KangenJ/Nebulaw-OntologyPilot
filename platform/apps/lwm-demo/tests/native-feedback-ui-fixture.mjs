import {createNativeFeedbackReview} from '../public-plus/native-feedback-ui.js';

// Explicit DOM adapter only. Callers choose a declared HTTP double or real HTTP.
// It exercises shipped handlers, not browser layout or native browser events.
export function feedbackUiFixture({api,principal={id:'reviewer',roles:['data_reviewer']},root={type:'Machine',id:'machine_1'}}){
  let html='',buttons=[],last=Promise.resolve(),busy=false,error,actor=principal,reference=root;
  const nodes=new Map(),$=s=>nodes.get(s),node=s=>{const value={};nodes.set(s,value);return value;};
  Object.defineProperty(node('#feedback-review'),'innerHTML',{get:()=>html,set:value=>{
    html=value;
    for(const key of [...nodes.keys()])if(key!=='#feedback-review')nodes.delete(key);
    for(const m of value.matchAll(/id="([^"]+)"/g))node('#'+m[1]);
    buttons=[...value.matchAll(/data-feedback-id="([^"]+)"/g)].map(m=>({dataset:{feedbackId:m[1]}}));
    if($('#feedback-review-form')){
      $('#feedback-decision').value=value.includes('value="APPROVE" selected')?'APPROVE':'REJECT';
      $('#feedback-reason').value=value.match(/id="feedback-reason"[^>]*>([^<]*)</)?.[1]??'';
      $('#feedback-confirm').checked=/id="feedback-confirm"[^>]*checked/.test(value);
    }
  }});
  const run=fn=>{if(busy)return;busy=true;last=fn(1).catch(e=>error=e).finally(()=>busy=false);return last;};
  const ui=createNativeFeedbackReview({document:{querySelector:$,querySelectorAll:s=>s==='[data-feedback-id]'?buttons:[]},api,run,isBusy:()=>busy,
    getDetail:()=>reference?{reference}:undefined,getPrincipal:()=>actor});ui.render();
  return {ui,$,html:()=>html,error:()=>error,settle:()=>last,actor:p=>actor=p,root:r=>reference=r,
    refresh:async()=>{$('#feedback-refresh').onclick();await last;},
    choose:async id=>{buttons.find(b=>b.dataset.feedbackId===id).onclick();await last;},
    submit:async(decision='APPROVE',reason='Independent source review',confirm=true)=>{
      $('#feedback-decision').value=decision;$('#feedback-reason').value=reason;$('#feedback-confirm').checked=confirm;
      $('#feedback-review-form').onsubmit({preventDefault(){}});await last;
    }};
}

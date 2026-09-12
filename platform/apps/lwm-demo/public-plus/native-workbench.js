import {parseAccessFile} from './access-file.js';
import {normalizeAccessToken,validatedPrincipal,loginErrorMessage} from './native-session.js';
import {requestNativeJson} from './native-request.js';
import {createNativeOntologyWorkbench} from './native-ontology-ui.js';
import {createNativeDataWorkbench} from './native-data-ui.js';
import {createNativeLinksView} from './native-links-ui.js';
import {createNativeLearningWorkbench} from './native-learning-ui.js';
import {createNativeActionWorkflow} from './native-action-workflow-ui.js';
import {createNativeAnalysisWorkbench} from './native-analysis-ui.js';
import {createNativeScenarioWorkbench} from './native-scenarios-ui.js';
import {createNativeGovernanceWorkbench} from './native-governance-ui.js';
import {createNativeJourneyWorkbench} from './native-journey-ui.js';

const views=[['journey','决策全过程'],['data','数据工作台'],['ontology','本体工作台'],['objects','对象浏览器'],['analysis','分析工作台'],['scenarios','决策与推演'],['actions','行动工作台'],['learning','学习与模型'],['governance','治理与运维']];
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pretty=value=>'<pre>'+escape(JSON.stringify(value,null,2))+'</pre>';
const discarded=()=>Object.assign(Error('会话已变化，旧响应已丢弃'),{discarded:true});

// Same platform shell, native-v2 data adapter. No /state aggregate or synthetic
// fallback. Rendered data and credentials remain memory-only for this session.
export function startNativeWorkbench({document=globalThis.document,request=globalThis.fetch}={}){
  const $=selector=>document.querySelector(selector);
  let token='',principal=null,catalog=null,type='',page=null,detail=null,view='objects',filter={},cursors=[''],pageIndex=0,generation=0,busy=false,credentials=[];
  const journeyTools=new Map();let journeyTool='',journeyToolContext='',journeyPriorDetail=null;
  function clearJourneyTools(){for(const e of journeyTools.values()){e.ui.reset();e.node.innerHTML='';}journeyTools.clear();journeyTool='';}
  function mountJourneyTool(step){const name={0:'data',3:'scenarios',4:'actions',6:'learning'}[step],entry=journeyTools.get(name),slot=$('#flow-tool-slot');if(slot&&entry&&journeyTool===name){slot.hidden=false;slot.appendChild(entry.node);}}
  function openJourneyTool(name){if(busy||!detail||!['data','scenarios','actions','learning'].includes(name))return;
    let entry=journeyTools.get(name);if(!entry){const node=document.createElement('div');node.className='flow-tool-'+name;const scoped={querySelector:s=>s==='#content'?node:node.querySelector(s),querySelectorAll:s=>node.querySelectorAll(s)};
      let scenarioReference;
      const options={document:scoped,api:async(...args)=>{const v=await api(...args);if(name==='scenarios'&&args[0]==='/learning/scenarios/view'&&v?.readOnly===true&&v.schema==='plus-scenario-workbench-result-v1'&&v.root?.id===detail?.reference.id&&v.root?.type===detail?.reference.type)scenarioReference={id:v.scenario?.id,context:journeyToolContext};return v;},run:async task=>{await run(async epoch=>{try{await task(epoch);}finally{journey.markNeedRefresh();}});const ref=scenarioReference;scenarioReference=undefined;if(ref&&view==='journey'&&ref.context===journeyToolContext)await journey.openKnownScenario(ref.id);},isBusy:()=>busy,getCatalog:()=>catalog,getDetail:()=>detail,getPrincipal:()=>principal,onOpenObject:openObject,onGoActions:()=>{journey.showStep(4);openJourneyTool('actions');}};
      const factory={data:createNativeDataWorkbench,scenarios:createNativeScenarioWorkbench,actions:createNativeActionWorkflow,learning:createNativeLearningWorkbench}[name];entry={node,ui:factory(options)};journeyTools.set(name,entry);}
    journeyTool=name;const slot=$('#flow-tool-slot');if(slot){slot.hidden=false;slot.replaceChildren(entry.node);}entry.ui.render();
  }
  const ontology=createNativeOntologyWorkbench({document,api,run,isBusy:()=>busy,getCatalog:()=>catalog,getPrincipal:()=>principal,onPublished:refresh});
  const data=createNativeDataWorkbench({document,api,run,isBusy:()=>busy,getCatalog:()=>catalog,getDetail:()=>detail,onOpenObject:openObject});
  const links=createNativeLinksView({document,api,run,isBusy:()=>busy,getCatalog:()=>catalog,getDetail:()=>detail,onRender:render,onOpenObject:openObject});
  const learning=createNativeLearningWorkbench({document,api,run,isBusy:()=>busy,getDetail:()=>detail,getPrincipal:()=>principal});
  const actions=createNativeActionWorkflow({document,api,run,isBusy:()=>busy,getDetail:()=>detail,getPrincipal:()=>principal});
  const analysis=createNativeAnalysisWorkbench({document,api,run,isBusy:()=>busy,getDetail:()=>detail,getCatalog:()=>catalog,getPrincipal:()=>principal,onOpenObject:openObject});
  const scenarios=createNativeScenarioWorkbench({document,api,run,isBusy:()=>busy,getDetail:()=>detail,getPrincipal:()=>principal,onGoActions:()=>{view='actions';render();actions.showProposal();}});
  const governance=createNativeGovernanceWorkbench({document,api,run,isBusy:()=>busy,getDetail:()=>detail,getPrincipal:()=>principal});
  const journey=createNativeJourneyWorkbench({document,api,run,isBusy:()=>busy,getDetail:()=>detail,getPreviousDetail:()=>journeyPriorDetail,getPrincipal:()=>principal,getCatalog:()=>catalog,onOpenObject:openObject,onSelectRoot:async(r,epoch)=>{await openObject(r,epoch);view='journey';render();},onRefreshRoot:()=>run(async epoch=>{if(detail){const prior=detail;const fresh=await api('/objects/'+encodeURIComponent(prior.reference.type)+'/'+encodeURIComponent(prior.reference.id),epoch);journeyPriorDetail=prior;detail=fresh;render();}}),onOpenTool:openJourneyTool,onMountTool:mountJourneyTool,isActive:()=>view==='journey',onNavigate:next=>{if(views.some(([key])=>key===next)){view=next;render();}}});
  const types=()=>catalog?.bundle?.parsed?.objectTypes??[];
  function clearData(){catalog=null;type='';page=null;detail=null;filter={};cursors=[''];pageIndex=0;ontology.reset();data.reset();links.reset();learning.reset();actions.reset();analysis.reset();scenarios.reset();governance.reset();journey.reset();for(const e of journeyTools.values()){e.ui.reset();e.node.innerHTML='';}journeyTools.clear();journeyTool='';}
  function clearCredentials(){journeyPriorDetail=null;credentials=[];$('#login-form').reset();$('#access-file').value='';$('#access-role').innerHTML='<option>先读取访问文件</option>';$('#access-role').disabled=true;$('#access-info').textContent='';}
  function logout(){generation++;token='';principal=null;clearData();clearCredentials();$('#notice').textContent='';render();}
  async function api(path,epoch,body,key){
    if(!token||epoch!==generation)throw discarded();
    return requestNativeJson({url:'/api'+path,
      options:{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{}),...(key?{'idempotency-key':key}:{})},...(body?{body:JSON.stringify(body)}:{}),cache:'no-store',redirect:'error'},
      request,isCurrent:()=>!!token&&epoch===generation,
      onUnauthorized:()=>{logout();$('#login-error').hidden=false;$('#login-error').textContent='凭据无效、已过期或撤销，请使用当前部署的个人凭据重新登录。';}});
  }
  async function run(task){
    if(busy)return;busy=true;const epoch=generation;
    $('#workspace').setAttribute('aria-busy','true');$('#notice').textContent='正在读取当前原生数据…';
    $('#workspace').inert=true;
    try{await task(epoch);if(epoch===generation)$('#notice').textContent='';}
    catch(error){if(!error.discarded&&epoch===generation){$('#notice').textContent=String(error.message);$('#notice').className='error';render();}}
    finally{busy=false;$('#workspace').inert=false;$('#workspace').setAttribute('aria-busy','false');}
  }
  async function list(epoch){
    page=null;detail=null;render();
    if(!type)return;
    const query=new URLSearchParams({limit:'25',...filter});if(cursors[pageIndex])query.set('after',cursors[pageIndex]);
    page=await api('/objects/'+encodeURIComponent(type)+'?'+query,epoch);render();
  }
  async function refresh(epoch){
    clearData();render();catalog=await api('/ontology',epoch);type=types()[0]?.name??'';render();
    // Schema access is not browse permission; do not probe every type on login.
  }
  async function openObject(reference,epoch){
    // Keep a successful import receipt visible if its new object is not readable.
    const value=await api('/objects/'+encodeURIComponent(reference.type)+'/'+encodeURIComponent(reference.id),epoch);
    if(type!==reference.type){type=reference.type;page=null;filter={};cursors=[''];pageIndex=0;}
    detail=value;view='objects';render();
  }
  function render(){
    const toolContext=JSON.stringify([principal?.id,principal?.tenantId,principal?.roles,detail?.reference]);if(toolContext!==journeyToolContext){clearJourneyTools();journeyToolContext=toolContext;}
    $('nav').innerHTML=views.map(([key,label])=>`<button data-native-view="${key}" class="${view===key?'active':''}" aria-current="${view===key?'page':'false'}">${label}</button>`).join('');
    document.querySelectorAll('[data-native-view]').forEach(button=>button.onclick=()=>{if(busy)return;view=button.dataset.nativeView;render();});
    $('#heading').textContent=views.find(([key])=>key===view)[1];
    $('#identity').textContent=principal?principal.id+' / '+principal.roles.join(', '):'尚未登录';
    $('#login').hidden=!!principal;$('#workspace').hidden=!principal;$('#logout').hidden=!principal;
    $('#matter-select').innerHTML=detail?`<option>${escape(detail.reference.type+' / '+detail.reference.id)}</option>`:'<option>请从对象列表选择</option>';
    $('#matter-select').disabled=true;
    $('#object-context').textContent=detail?`${detail.reference.type} · ${detail.reference.id} · v${detail.reference.version}`:'';
    if(!principal){$('#content').innerHTML='';$('#matter-select').innerHTML='';return;}
    if(view==='ontology'){
      ontology.render();return;
    }
    if(view==='data'){data.render();return;}
    if(view==='journey'){journey.render();return;}
    if(view==='learning'){learning.render();return;}
    if(view==='actions'){actions.render();return;}
    if(view==='analysis'){analysis.render();return;}
    if(view==='scenarios'){scenarios.render();return;}
    if(view==='governance'){governance.render();return;}
    if(view!=='objects'){
      $('#content').innerHTML=`<section class="panel"><h2>${escape(views.find(([key])=>key===view)[1])}：界面尚未接线</h2><p>当前原生 v2 页面已接入身份、有限报告导入、本体基础编辑与对象列表/详情。后端已有代码不表示此工作台已验收，不展示预置模型、审批或学习结果。</p><p>当前对象：${escape(detail?detail.reference.type+' / '+detail.reference.id:'尚未选择')}</p></section>`;return;
    }
    const fields=(types().find(t=>t.name===type)?.fields??[]).filter(f=>f.type.name==='String'&&!f.type.isList&&!f.directives.some(d=>['link','computed'].includes(d.kind)));
    $('#content').innerHTML=`<section class="panel"><h2>查找原生对象</h2><p>本体可见不代表对象可读。服务端按当前身份过滤工作区和字段；403 表示没有该操作授权。</p><form id="native-query"><div class="row"><label>本体对象类型<select id="native-type">${types().map(t=>`<option value="${escape(t.name)}" ${type===t.name?'selected':''}>${escape(t.name)}</option>`).join('')}</select></label><label>字符串筛选字段<select id="native-field"><option value="">不筛选</option>${fields.map(f=>`<option value="${escape(f.name)}" ${filter.field===f.name?'selected':''}>${escape(f.name)}</option>`).join('')}</select></label><label>条件<select id="native-operator">${[['contains','包含'],['eq','等于'],['startsWith','开头为']].map(([op,label])=>`<option value="${op}" ${(filter.operator??'contains')===op?'selected':''}>${label}</option>`).join('')}</select></label><label>筛选值<input id="native-value" maxlength="256" value="${escape(filter.value??'')}"></label></div><button class="primary">查询当前对象</button></form></section><section class="panel"><h2>授权结果 · 第 ${pageIndex+1} 页</h2><p>每页最多25项；按对象ID排序。跨页不是冻结快照，新数据可重新查询。</p><div class="table-wrap"><table><thead><tr><th>对象</th><th>版本</th><th>已授权属性</th></tr></thead><tbody>${page?.items?.length?page.items.map(item=>`<tr><td><button data-native-object="${escape(item.reference.id)}">${escape(item.reference.id)}</button></td><td>${escape(item.reference.version)}</td><td>${pretty(item.object)}</td></tr>`).join(''):'<tr><td colspan="3">'+(page?'当前范围无匹配对象':'尚未查询或上次查询失败，未显示旧结果')+'</td></tr>'}</tbody></table></div><div class="row"><button id="native-prev" ${pageIndex===0?'disabled':''}>上一页</button><button id="native-next" ${page?.hasMore?'':'disabled'}>下一页</button></div></section>${detail?'<section class="panel"><h2>当前对象详情</h2><p>原生引用 '+escape(detail.reference.type+' / '+detail.reference.id+' / v'+detail.reference.version)+'</p>'+pretty(detail.object)+'<p>下方可查询原生一跳关系；多跳图和版本历史界面尚未接入。</p></section>':''}`;
    $('#content').innerHTML+=links.markup();links.bind();
    $('#native-type').onchange=()=>{if(busy)return;type=$('#native-type').value;filter={};page=null;detail=null;cursors=[''];pageIndex=0;render();};
    $('#native-query').onsubmit=event=>{event.preventDefault();if(busy)return;const field=$('#native-field').value;filter=field?{field,operator:$('#native-operator').value,value:$('#native-value').value}:{};cursors=[''];pageIndex=0;void run(list);};
    $('#native-prev').onclick=()=>{if(busy||pageIndex===0)return;pageIndex--;void run(list);};
    $('#native-next').onclick=()=>{if(busy||!page?.hasMore)return;cursors=cursors.slice(0,pageIndex+1);cursors.push(page.nextAfter);pageIndex++;void run(list);};
    document.querySelectorAll('[data-native-object]').forEach(button=>button.onclick=()=>void run(async epoch=>{detail=null;render();detail=await api('/objects/'+encodeURIComponent(type)+'/'+encodeURIComponent(button.dataset.nativeObject),epoch);render();}));
  }
  $('#login-form').onsubmit=event=>{event.preventDefault();if(busy)return;const entered=new FormData(event.currentTarget).get('token');logout();
    try{token=normalizeAccessToken(entered);}catch(error){$('#login-error').hidden=false;$('#login-error').textContent=loginErrorMessage(error);return;}
    void run(async epoch=>{
    try{principal=validatedPrincipal(await api('/me',epoch));clearCredentials();$('#login-error').hidden=true;render();await refresh(epoch);}
    catch(error){if(!principal&&epoch===generation){logout();$('#login-error').hidden=false;$('#login-error').textContent=loginErrorMessage(error);}throw error;}
  });};
  $('#logout').onclick=()=>{logout();$('#login-error').hidden=true;};
  $('#refresh').onclick=()=>{if(principal)void run(refresh);};
  $('#access-file').onchange=()=>void run(async epoch=>{
    const file=$('#access-file').files[0];clearCredentials();if(!file)return;
    if(file.size>50000)throw Error('访问文件过大');const parsed=parseAccessFile(await file.text());if(epoch!==generation)throw discarded();
    credentials=parsed.credentials;$('#access-role').innerHTML=credentials.map((c,i)=>`<option value="${i}">${escape(c.id+' / '+c.role)}</option>`).join('');$('#access-role').disabled=false;
    $('#access-role').value='0';$('#login-form input[name=token]').value=credentials[0]?.token??'';
    $('#access-info').textContent='文件仅在本机解析；权限以服务器当前认证为准。有效期：'+parsed.expiresAt;
  });
  $('#access-role').onchange=()=>{$('#login-form input[name=token]').value=credentials[Number($('#access-role').value)]?.token??'';};
  render();
}

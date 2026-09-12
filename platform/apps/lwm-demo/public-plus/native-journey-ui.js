import {flowMarkup} from './native-journey-flow.js';
import {mockMarkup} from './native-journey-mock.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ref=v=>v&&typeof v.id==='string'&&typeof v.type==='string'&&Number.isSafeInteger(v.version)&&v.version>0;
const same=(a,b)=>a?.id===b?.id&&a?.type===b?.type&&a?.version===b?.version;
const bad=()=>{throw Error('INVALID_JOURNEY_RESPONSE');};
const fmt=v=>v==null?'未提供':String(v);
const pretty=v=>'<pre>'+esc(JSON.stringify(v,null,2))+'</pre>';
const stateKey=v=>{
  if(typeof v==='string'&&v.length>0&&v.length<=2048)return JSON.stringify(v);
  if(!v||typeof v!=='object'||Array.isArray(v))return null;
  const entries=Object.entries(v).sort(([a],[b])=>a.localeCompare(b));
  if(!entries.length||entries.length>128||entries.some(([k,x])=>!k||k.length>256||!(typeof x==='string'&&x.length<=2048||typeof x==='boolean'||typeof x==='number'&&Number.isFinite(x))))return null;
  return JSON.stringify(entries);
};
const stateLabel=v=>typeof v==='string'?v:Object.entries(v).map(([k,x])=>k+' = '+String(x)).join(' · ');
const states=v=>{
  const rows=v?.explanation?.states;
  if(!Array.isArray(rows)||!rows.length||rows.length>128||rows.some(r=>!r||stateKey(r.state)===null||!Number.isFinite(r.p)||r.p<0||r.p>1)||new Set(rows.map(r=>stateKey(r.state))).size!==rows.length||Math.abs(rows.reduce((n,r)=>n+r.p,0)-1)>1e-8)return null;
  return rows;
};
export function reportSummary(page){
  if(!page)return null;
  const objects=[...new Map(page.items.map(i=>[i.neighbor.reference.id,i.neighbor.object])).values()];
  const values=new Set(objects.map(o=>o.reportedCompletion).filter(v=>typeof v==='string'&&v!=='UNKNOWN'));
  return {count:objects.length,conflict:values.size>1,partial:page.hasMore,objects};
}

// Presentation only. All state is session-local, actor/root/version bound.
// POST is used exclusively for the existing read-only scenario/view contract.
// No new source of facts, approvals, training, scenario computation or replay.
export function createNativeJourneyWorkbench({document,api,run,isBusy,getPrincipal,getDetail,getCatalog,getPreviousDetail=()=>null,onNavigate,onOpenObject,onSelectRoot=onOpenObject,onRefreshRoot=async()=>{},onOpenTool=()=>{},onMountTool=()=>{},isActive=()=>true}){
  const $=s=>document.querySelector(s);let identity='',generation=0,sections={},choice='',selectedScenario='',checkedAt='';
  let guided=true,step=0,needsRefresh=false;
  let mock=false,mockStep=0,mockAvailability=0.8;
  const context=()=>JSON.stringify([getPrincipal()?.tenantId,getPrincipal()?.id,[...(getPrincipal()?.roles??[])].sort(),getDetail()?.reference]);
  function reset(){generation++;identity='';sections={};choice=selectedScenario=checkedAt='';step=0;needsRefresh=false;mock=false;mockStep=0;mockAvailability=0.8;}
  function sync(){if(identity!==context()){reset();identity=context();}}
  const record=(name,status,value=null,message='')=>{sections[name]={status,value,message};};
  const value=name=>sections[name]?.status==='ready'?sections[name].value:null;
  const caption=name=>({loading:'正在读取…',denied:'当前身份无权读取',unavailable:'当前不可用',error:'读取失败',unsupported:'当前本体未配置该关系'}[sections[name]?.status]??'尚未读取');
  const status=name=>`<p class="journey-status" role="status">${esc(caption(name))}${sections[name]?.message?' · '+esc(sections[name].message):''}</p>`;
  function perform(fn){sync();if(isBusy()||!getDetail()?.reference)return;const g=generation,c=context();
    return run(async epoch=>{const valid=()=>{if(g!==generation||c!==context())throw Object.assign(Error('总览身份或对象已变化'),{discarded:true});};
      try{await fn(epoch,valid);valid();checkedAt=new Date().toISOString();}finally{if(g===generation&&c===context()&&isActive())render();}});
  }
  async function readPart(name,path,epoch,valid,validate,body){record(name,'loading');
    try{const v=await api(path,epoch,body);valid();validate(v);record(name,'ready',v);return v;}
    catch(e){valid();if(e.discarded)throw e;const msg=String(e.message);record(name,/FORBIDDEN|权限|403/.test(msg)?'denied':/STALE|REVOKED|UNAVAILABLE|NOT_CONFIGURED/.test(msg)?'unavailable':'error',null,msg);return null;}
  }
  const rootPath=r=>'/objects/'+encodeURIComponent(r.type)+'/'+encodeURIComponent(r.id);
  function validateObject(v,r){if(v?.readOnly!==true||!same(v.reference,r)||v.object?._id!==r.id||v.object?._type!==r.type||v.object?._version!==r.version||v.object?._tenantId!==getPrincipal().tenantId)bad();}
  async function links(name,r,linkType,direction,targetType,epoch,valid){
    const definition=getCatalog()?.bundle?.parsed?.linkTypes?.find(l=>l.name===linkType);
    if(!definition||(direction==='outbound'?definition.from!==r.type||definition.to!==targetType:definition.to!==r.type||definition.from!==targetType)){record(name,'unsupported');return null;}
    return readPart(name,rootPath(r)+'/links?'+new URLSearchParams({linkType,direction,limit:'25'}),epoch,valid,v=>{
      if(v?.readOnly!==true||!same(v.root,r)||v.linkType!==linkType||v.direction!==direction||typeof v.hasMore!=='boolean'||!Array.isArray(v.items)||v.items.length>25)bad();
      for(const i of v.items){const n=i.neighbor,l=i.link;if(!ref(n?.reference)||n.reference.type!==targetType||l?._type!==linkType)bad();validateObject(n,n.reference);
        if(direction==='outbound'?(l._fromType!==r.type||l._fromId!==r.id||l._toType!==targetType||l._toId!==n.reference.id):(l._toType!==r.type||l._toId!==r.id||l._fromType!==targetType||l._fromId!==n.reference.id))bad();}
    });
  }
  function load(){return perform(async(epoch,valid)=>{sections={};choice=selectedScenario='';checkedAt='';needsRefresh=false;render();const r=structuredClone(getDetail().reference);
    const fresh=await readPart('root',rootPath(r),epoch,valid,v=>validateObject(v,r));if(!fresh)return;
    const observations=(getCatalog()?.bundle?.parsed?.linkTypes??[]).find(l=>l.from===r.type&&l.to==='Observation');
    if(observations)await links('reports',r,observations.name,'outbound','Observation',epoch,valid);else record('reports','unsupported');
    await readPart('processes','/learning/scenarios/options?'+new URLSearchParams({rootType:r.type,rootId:r.id}),epoch,valid,v=>{
      if(v?.schema!=='plus-scenario-workbench-options-v1'||v.readOnly!==true||!same(v.root,r)||v.qualification!=='NOT_CHECKED'||v.predictionReady!==false||v.executionAuthorized!==false||!Array.isArray(v.items)||v.items.length>1000)bad();
      if(new Set(v.items.map(i=>i.optionKey)).size!==v.items.length)bad();
      for(const i of v.items)if(!same(i.root,r)||typeof i.optionKey!=='string'||typeof i.key!=='string'||typeof i.episode?.id!=='string'||i.qualification!=='NOT_CHECKED'||i.predictionReady!==false)bad();
    });
    await readPart('feedback','/learning/feedback?'+new URLSearchParams({rootType:r.type,rootId:r.id}),epoch,valid,v=>{
      if(v?.schema!=='plus-feedback-root-index-v1'||v.readOnly!==true||v.learningEligible!==false||v.root?.id!==r.id||v.root?.type!==r.type||!Array.isArray(v.items)||v.items.length>500||v.items.some(i=>typeof i.id!=='string'||i.qualification!=='NOT_CHECKED'))bad();
    });
    await readPart('audit','/governance/object?'+new URLSearchParams({rootType:r.type,rootId:r.id,limit:'25'}),epoch,valid,v=>{
      if(v?.schema!=='plus-governance-object-v1'||v.readOnly!==true||!same(v.root,r)||v.qualification!=='NOT_CHECKED'||v.executionAuthorized!==false||!Array.isArray(v.items)||v.items.length>25||typeof v.hasMore!=='boolean')bad();
    });
    // Independent requests are NOT an atomic cross-module snapshot. Root drift
    // invalidates the whole batch; each model/scenario still qualifies separately.
    const end=await readPart('root',rootPath(r),epoch,valid,v=>validateObject(v,r));
    if(!end){const error=sections.root;sections={root:error};choice='';}
  });}
  function loadModel(){const selected=value('processes')?.items.find(i=>i.optionKey===choice);if(!selected)return;return perform(async(epoch,valid)=>{
    for(const k of ['belief','previous','history','scenarioList','scenario'])delete sections[k];selectedScenario='';render();
    const b=await readPart('belief','/learning/beliefs/'+encodeURIComponent(selected.key)+'/episodes/'+encodeURIComponent(selected.episode.id),epoch,valid,v=>{
      if(v?.predictionReady!==true||v.current!==true||v.readiness!=='READY'||v.beliefId!==v.record?._id||v.record?._tenantId!==getPrincipal().tenantId||v.head?.episodeId!==selected.episode.id||v.head?.controlKey!==selected.key||v.record?.distribution?.episodeKey!==selected.episode.id||!states(v.record))bad();
    });
    if(b){const p=b.record.payload?.previous;
      if(p?.id&&Number.isSafeInteger(p.version))await readPart('previous',rootPath({type:'PlusBeliefSnapshot',id:p.id}),epoch,valid,v=>{
        validateObject(v,{type:'PlusBeliefSnapshot',id:p.id,version:p.version});if(v.object.distribution?.episodeKey!==selected.episode.id||!states(v.object)||v.object.contentHash!==p.hash)bad();
      });
      await links('scenarioList',{type:'PlusBeliefSnapshot',id:b.beliefId,version:b.beliefVersion},'PlusScenarioBelief','inbound','PlusScenarioRun',epoch,valid);
    }
    await readPart('history','/learning/deployments/'+encodeURIComponent(selected.key)+'/revisions',epoch,valid,v=>{
      if(v?.schema!=='plus-model-selection-history-index-v1'||v.key!==selected.key||v.readOnly!==true||v.predictionReady!==false||v.executionAuthorized!==false||!Array.isArray(v.items)||v.items.length>1000||v.items.some(i=>i.qualification!=='NOT_CHECKED'||typeof i.release?.key!=='string'||!Number.isSafeInteger(i.generation)))bad();
    });
  });}
  function readScenario(){const scenarioId=selectedScenario;if(!value('belief')||!/^[-A-Za-z0-9_.:]{1,256}$/.test(scenarioId))return;return perform(async(epoch,valid)=>{
    delete sections.scenario;render();const r=getDetail().reference;
    await readPart('scenario','/learning/scenarios/view',epoch,valid,v=>{
      const p=v?.predictions;if(v?.schema!=='plus-scenario-workbench-result-v1'||v.readOnly!==true||!same(v.root,r)||v.scenario?.id!==scenarioId||v.currentBasisChecked!==true||v.nativeAdmissionChecked!==true||v.businessFactsWritten!==false||v.executionAuthorized!==false||v.basis?.belief?.id!==value('belief')?.beliefId)bad();
      if(p?.schema!=='plus-verification-comparison-v1'||p.businessFactsWritten!==false||p.executionAuthorized!==false||p.semantics!=='HYPOTHETICAL_INFORMATION_VALUE_NOT_VERIFIED_ACTION_EFFECT'||p.assumptions?.physicalTransition!=='NONE'||p.assumptions?.target!=='SAME_TARGET_TIME'||!Number.isFinite(p.assumptions.availabilityProbability)||p.assumptions.availabilityProbability<0||p.assumptions.availabilityProbability>1||!Array.isArray(p.options)||p.options.length!==2||new Set(p.options.map(o=>o.key)).size!==2||p.options.some(o=>!['NO_ADDITIONAL_VERIFICATION','REQUEST_VERIFICATION'].includes(o.key)||!Number.isFinite(o.expectedLoss)||o.expectedLoss<0)||p.recommendation!==null&&!p.options.some(o=>o.key===p.recommendation))bad();
    },{rootType:r.type,rootId:r.id,scenarioId});
  });}
  function bars(record){const rows=states(record);return rows?rows.map(s=>`<div class="journey-prob"><span>${esc(stateLabel(s.state))}</span><strong>${(s.p*100).toFixed(1)}%</strong><div class="bar"><i style="width:${(s.p*100).toFixed(4)}%"></i></div></div>`).join(''):'<p>没有受支持的状态分布，不推算概率。</p>';}
  function button(view,label){return `<button data-journey-go="${view}">${esc(label)} →</button>`;}
  function render(){sync();if(!isActive())return;const r=getDetail()?.reference,o=value('root')?.object??getDetail()?.object,summary=reportSummary(value('reports')),b=value('belief'),previous=value('previous')?.object,processes=value('processes'),history=value('history'),scenario=value('scenario'),feedback=value('feedback'),audit=value('audit');
    if(mock){
      $('#content').innerHTML=mockMarkup(mockStep,mockAvailability);
      const moveMock=n=>{if(isBusy()||!Number.isInteger(n)||n<0||n>6)return;mockStep=n;render();};
      document.querySelectorAll('[data-mock-step]').forEach(b=>b.onclick=()=>moveMock(Number(b.dataset.mockStep)));
      $('#mock-prev').onclick=()=>moveMock(mockStep-1);$('#mock-next').onclick=()=>moveMock(mockStep+1);
      $('#flow-mock-exit').onclick=()=>{if(isBusy())return;mock=false;render();};
      if($('#mock-availability'))$('#mock-availability').onchange=()=>{const p=Number($('#mock-availability').value);if(!isBusy()&&[0.2,0.5,0.8,1].includes(p)){mockAvailability=p;render();}};
      return;
    }
    const conflict=summary?.conflict,classification=o?.dataClassification??'分类未提供';
    $('#content').innerHTML=`<div class="journey"><section class="panel journey-hero"><div class="eyebrow">PLUS / 决策全过程</div><h2>${esc(o?.title??'从一个真实对象，理解一次决策')}</h2><p class="journey-lead">${!r?'先选择业务对象，再看证据如何支持判断、行动如何受到约束。':conflict?'发现不同结论的来源报告。先看证据，再决定是否值得继续核验。':summary?'已读取可见报告；未发现不同已报告值，不代表证据已充分或事实已核实。':'把分散的工作台串成一个可追溯过程，不生成预置结论。'}</p><div class="row"><span class="badge">${esc(classification)}</span><span class="badge">只读总览 · 不自动执行</span>${r?`<button id="journey-load" class="primary">读取 / 刷新决策全过程</button>`:button('objects','选择业务对象')}</div><p class="muted">${r?esc(r.type+' / '+r.id+' / v'+r.version):'兼容当前本体；没有配置的能力会单独标明。'}${checkedAt?' · 最近读取 '+esc(checkedAt):''}</p>${sections.root&&sections.root.status!=='ready'?status('root'):''}</section>
    <ol class="journey-stages">${[['01','发现冲突','来源报告 ≠ 事实'],['02','更新判断','证据改变条件判断'],['03','比较方案','权衡信息与成本'],['04','受控行动','提案、审批、执行分离'],['05','反馈改进','登记、评测、发布分离']].map(([n,t,d])=>`<li><span>${n}</span><strong>${t}</strong><small>${d}</small></li>`).join('')}</ol>
    <div class="journey-columns"><section class="panel"><div class="eyebrow">01 / 证据</div><h2>${conflict?'报告存在不同结论':'当前可见来源报告'}</h2><div class="journey-fact"><span>业务对象记录 · 非模型预测</span><strong>${esc(fmt(o?.actualCompletion))}</strong><p>流程状态：${esc(fmt(o?.status))}。只有独立核验和原生动作才能改变业务事实。</p></div>${summary?`<p>${summary.count}个可见独立对象${summary.partial?'（仅首25条关系，结果不完整）':''}。不同报告可能指向不同时间或来源；不自动判定谁对谁错。</p>${value('reports').items.map((i,n)=>`<article class="journey-evidence"><span class="badge">来源报告</span><strong>${esc(fmt(i.neighbor.object.reportedCompletion))}</strong><p>${esc(i.neighbor.object.title??i.neighbor.object.summary??'未提供摘要')}</p><small>来源：${esc(fmt(i.neighbor.object.sourceSystem??i.neighbor.object.source))} · 获知时间：${esc(fmt(i.neighbor.object.receivedAt??i.neighbor.object.recordedAt))}</small><button data-journey-report="${n}">查看原始证据</button></article>`).join('')}`:status('reports')}${button('analysis','进入关联分析')}</section>
    <section class="panel"><div class="eyebrow">02 / 判断</div><h2>证据到判断，不跳过依据</h2>${processes?`<label>当前对象的授权分析过程<select id="journey-process"><option value="">请选择过程</option>${processes.items.map(i=>`<option value="${esc(i.optionKey)}" ${choice===i.optionKey?'selected':''}>${esc(i.key+' / '+i.episode.id)}</option>`).join('')}</select></label><button id="journey-model" ${choice?'':'disabled'}>核验当前判断与版本历史</button>${!processes.items.length?'<p>当前身份和对象范围没有可见过程；不代表平台没有模型。</p>':''}`:status('processes')}
    ${b?`<div class="journey-compare"><div><h3>上一条历史存档</h3><span class="badge">历史记录 · 非当前资格</span>${previous?bars(previous):status('previous')}</div><div><h3>本次核验的当前判断</h3><span class="badge">条件预测 · 读取时有效</span>${bars(b.record)}</div></div><p>当前目标时点：${esc(fmt(b.record.payload?.result?.estimate?.targetTime))}<br>知识截止：${esc(fmt(b.record.payload?.result?.estimate?.visibleAt))}<br>历史目标：${esc(fmt(previous?.payload?.result?.estimate?.targetTime))}；历史知识截止：${esc(fmt(previous?.payload?.result?.estimate?.visibleAt))}</p><p>这是状态更新，不是本次重新训练；时点、输入或模型可能不同，前后变化不自动归因于某一条证据。不使用相减值声称模型改善。</p><details><summary>核验依据与模型血缘</summary>${pretty({beliefId:b.beliefId,headVersion:b.headVersion,generation:b.generation,engine:b.record.engineVersion,release:b.record.payload?.readSet?.release,selection:b.record.payload?.readSet?.selection})}</details>`:status('belief')}${button('learning','查看学习与模型')}</section></div>
    <section class="panel"><div class="eyebrow">03 / 决策</div><h2>下一步值得做吗？</h2><p>只读取已登记方案并重新核验。新的假设和计算仍在决策与推演工作台进行。</p>${value('scenarioList')?`<label>当前判断关联的方案（非执行许可）<select id="journey-scenario"><option value="">请选择已登记方案</option>${value('scenarioList').items.map(i=>`<option value="${esc(i.neighbor.reference.id)}" ${selectedScenario===i.neighbor.reference.id?'selected':''}>${esc(i.neighbor.reference.id+' / v'+i.neighbor.reference.version)}</option>`).join('')}</select></label><button id="journey-scenario-read" ${selectedScenario?'':'disabled'}>核验并对比方案</button><p>${value('scenarioList').hasMore?'仅首25条可见关系，非完整目录。':'当前可见关系范围；空目录不代表不存在其他方案。'}</p>`:status('scenarioList')}
    ${b?`<label>已有方案 ID<input id="journey-scenario-id" maxlength="256" value="${esc(selectedScenario)}" placeholder="粘贴决策与推演工作台的原生方案 ID"></label><button id="journey-scenario-direct">核验指定方案</button><p class="muted">无需开放模型内部对象目录。指定 ID 仍由方案专用接口核验身份、业务对象、当前模型和信念；无权或失效会拒绝，不创建新方案。</p>`:''}
    ${scenario?`<p><span class="badge">${esc(scenario.classification)}</span> 假设：取得独立核验的概率为 ${(scenario.predictions.assumptions.availabilityProbability*100).toFixed(1)}%；不是模型置信度。</p><div class="journey-options">${scenario.predictions.options.map(p=>`<article class="journey-option"><h3>${p.key==='REQUEST_VERIFICATION'?'请求独立核验':'不追加核验'}</h3><strong>${esc(p.expectedLoss)}</strong><p>条件期望损失 / ${esc(scenario.predictions.unit)}</p>${scenario.predictions.recommendation===p.key?'<span class="badge">当前假设下建议</span>':''}</article>`).join('')}</div><p>同一目标时点的信息价值比较，不是已验证的物理行动效果或已实现的业务降本。未修改业务事实、未授予行动权限。</p><details><summary>方案原生来源与完整假设</summary>${pretty({scenario:scenario.scenario,assumptions:scenario.predictions.assumptions,basis:scenario.basis})}</details>`:status('scenario')}${button('scenarios','修改假设或计算新方案')}</section>
    <div class="journey-columns"><section class="panel"><div class="eyebrow">04 / 治理</div><h2>建议，不等于已经执行</h2><p>提案 → 独立审批 → 受治理执行。总览不批准、不执行，也不把审计投递成功当成现实结果。</p>${audit?`<p>${audit.items.length}条可见提交记录${audit.hasMore?'（分页未完）':''}；不是全量行动状态。</p><div class="table-wrap"><table><thead><tr><th>原生操作</th><th>结果 / 投递</th><th>身份 / 时间</th></tr></thead><tbody>${audit.items.map(a=>`<tr><td>${esc(a.audit?.actionType??a.audit?.operation)}</td><td>${esc(fmt(a.audit?.result))} / ${esc(a.status)}</td><td>${esc(fmt(a.audit?.actorId))}<br>${esc(fmt(a.audit?.timestamp))}</td></tr>`).join('')||'<tr><td colspan="3">当前范围无记录；不是不存在其他操作。</td></tr>'}</tbody></table></div>`:status('audit')}${button('actions','查看提案与独立审批')}${button('governance','查看原生审计')}</section>
    <section class="panel"><div class="eyebrow">05 / 学习</div><h2>什么改变了，什么尚未证明？</h2>${feedback?`<p>当前对象有${feedback.items.length}条可见反馈登记；登记不等于训练资格。</p><div class="journey-history">${feedback.items.map(f=>`<article><strong>${esc(f.status)}</strong><span>${esc(f.id)} / v${esc(f.version)}</span><small>当前资格未检查</small></article>`).join('')}</div>`:status('feedback')}
    ${history?`<h3>${esc(history.key)} · 模型用途级选择历史</h3><p>这是用途级记录，不意味着当前对象参与了每轮训练，也不包含全部被拒绝候选。</p><div class="journey-history">${history.items.slice().reverse().map(i=>`<article><strong>第 ${esc(i.generation)} 代${i.id===history.currentRevisionId?' · 当前登记':''}</strong><span>${esc(i.createdAt)}</span><small>工件 ${esc(i.release.key)} · 历史资格未检查</small></article>`).join('')}</div>`:status('history')}<div class="callout warning">独立效果对照：尚未在本页核验。没有合格评测结果，不显示“提升百分比”或“超越基线”。</div>${button('learning','检查反馈、评测与发布')}</section></div>
    <p class="muted">总览为分次授权读取，不是跨模块原子快照或实时监控。报告、历史、假设与当前核验结果分别标注；后续使用仍须重新鉴权和核验。</p></div>`;
    const legacy=$('#content').innerHTML;
    $('#content').innerHTML='<section class="panel"><span class="badge">新手入口 · Mock 数据</span><h3>用一个供应商整改验收案例走完七步</h3><p>先看懂业务流转，再操作真实对象。演练不调用模型、不提交动作，也不写入本体。</p><button id="flow-mock-open">开始 Mock 业务场景演练</button></section>'+(guided?flowMarkup({step,detail:getDetail(),previousDetail:getPreviousDetail(),sections,checkedAt,needsRefresh,legacy}):'<button id="flow-guided">返回业务引导</button>'+legacy);
    $('#flow-mock-open').onclick=()=>{if(isBusy())return;mock=true;mockStep=0;render();};
    if($('#flow-guided'))$('#flow-guided').onclick=()=>{if(isBusy())return;guided=true;render();};
    if($('#flow-expert'))$('#flow-expert').onclick=()=>{if(isBusy())return;guided=false;render();};
    const move=n=>{if(isBusy()||n<0||n>6)return;step=n;render();};
    document.querySelectorAll('[data-flow-step]').forEach(b=>b.onclick=()=>move(Number(b.dataset.flowStep)));
    if($('#flow-prev'))$('#flow-prev').onclick=()=>move(step-1);
    if($('#flow-next'))$('#flow-next').onclick=()=>move(step+1);
    const refreshFlow=async()=>{if(isBusy())return;const savedStep=step;await onRefreshRoot();sync();step=savedStep;await load();};
    if($('#flow-refresh'))$('#flow-refresh').onclick=()=>void refreshFlow();
    if($('#flow-result-refresh'))$('#flow-result-refresh').onclick=()=>void refreshFlow();
    if($('#flow-tool-open'))$('#flow-tool-open').onclick=()=>{if(!isBusy())onOpenTool($('#flow-tool-open').dataset.tool);};
    if($('#flow-search'))$('#flow-search').onclick=()=>{if(isBusy())return;sync();const g=generation,c=context(),q=$('#flow-search-text').value.trim();
      if(!(getCatalog()?.bundle?.parsed?.objectTypes??[]).some(t=>t.name==='InvestigationTask')){$('#flow-search-results').textContent='当前本体未配置任务类型，请使用对象浏览器。';return;}
      void run(async epoch=>{const target=$('#flow-search-results');target.textContent='正在读取授权任务…';try{const v=await api('/objects/InvestigationTask?'+new URLSearchParams({limit:'25',...(q?{field:'title',operator:'contains',value:q}:{})}),epoch);
        if(g!==generation||c!==context()||!isActive())return;if(!Array.isArray(v?.items)||v.items.length>25)bad();for(const i of v.items){if(!ref(i.reference)||i.reference.type!=='InvestigationTask')bad();validateObject(i,i.reference);}
        target.innerHTML=v.items.map((i,n)=>`<article><button data-flow-task="${n}">${esc(i.object.title??i.object.taskNumber??i.reference.id)}</button><p>${esc(i.object.taskNumber??'未提供编号')}</p></article>`).join('')||'<p>当前范围没有匹配任务。</p>';if(v.hasMore)target.innerHTML+='<p>仅显示首25项；可使用对象浏览器精确筛选。</p>';
        document.querySelectorAll('[data-flow-task]').forEach(b=>b.onclick=()=>{if(isBusy())return;const row=v.items[Number(b.dataset.flowTask)];if(row)void run(e=>onSelectRoot(row.reference,e));});
      }catch(e){if(g===generation&&c===context())target.textContent='任务读取失败：'+String(e.message);}});
    };
    if($('#journey-load'))$('#journey-load').onclick=()=>void load();
    if($('#journey-process'))$('#journey-process').onchange=()=>{if(isBusy())return;choice=$('#journey-process').value;for(const k of ['belief','previous','history','scenarioList','scenario'])delete sections[k];selectedScenario='';render();};
    if($('#journey-model'))$('#journey-model').onclick=()=>void loadModel();
    if($('#journey-scenario'))$('#journey-scenario').onchange=()=>{if(isBusy())return;selectedScenario=$('#journey-scenario').value;delete sections.scenario;render();};
    if($('#journey-scenario-read'))$('#journey-scenario-read').onclick=()=>void readScenario();
    if($('#journey-scenario-id'))$('#journey-scenario-id').oninput=()=>{if(isBusy())return;selectedScenario=$('#journey-scenario-id').value.trim();delete sections.scenario;const input=$('#journey-scenario-id'),cursor=input.selectionStart;render();const fresh=$('#journey-scenario-id');fresh.focus();fresh.setSelectionRange(cursor,cursor);};
    if($('#journey-scenario-direct'))$('#journey-scenario-direct').onclick=()=>{if(isBusy())return;selectedScenario=$('#journey-scenario-id').value.trim();delete sections.scenario;render();if(!/^[-A-Za-z0-9_.:]{1,256}$/.test(selectedScenario)){record('scenario','error',null,'请输入有效的原生方案 ID');render();return;}void readScenario();};
    document.querySelectorAll('[data-journey-go]').forEach(b=>b.onclick=()=>{if(!isBusy())onNavigate(b.dataset.journeyGo);});
    document.querySelectorAll('[data-journey-report]').forEach(b=>b.onclick=()=>{if(isBusy())return;const row=value('reports')?.items[Number(b.dataset.journeyReport)];if(row)void run(epoch=>onOpenObject(row.neighbor.reference,epoch));});
    if(guided)onMountTool(step);
  }
  return {render,reset,load,loadModel,readScenario,showStep(n){if(isBusy()||!Number.isInteger(n)||n<0||n>6)return;sync();guided=true;step=n;render();},markNeedRefresh(){needsRefresh=true;},async openKnownScenario(id){sync();if(isBusy()||!/^[-A-Za-z0-9_.:]{1,256}$/.test(id))return;selectedScenario=id;delete sections.scenario;if(value('belief'))await readScenario();else render();}};
}

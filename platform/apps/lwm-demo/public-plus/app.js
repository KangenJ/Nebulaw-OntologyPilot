import {renderEngineering} from './engineering-ui.js';
import {parseAccessFile} from './access-file.js';
const views=[['data','数据工作台'],['ontology','本体工作台'],['objects','对象浏览器'],['analysis','分析工作台'],['scenarios','决策与推演'],['actions','行动工作台'],['learning','学习与模型'],['governance','治理与运维']];
const $=selector=>document.querySelector(selector);
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const json=value=>JSON.stringify(value,null,2);
const pretty=value=>`<pre>${escape(json(value))}</pre>`;
const badge=value=>`<span class="badge">${escape(value)}</span>`;
let token='',principal=null,state=null,detail=null,selected='',view='data',noticeTimer;
const pendingKeys=new Map();
let mapping={},suggestion=null,analysis=null,lastSimulation='',busy=false;
const items=type=>state?.objects[type]?.items??[];
const current=()=>items('Matter').find(m=>m._id===selected);
const role=name=>principal?.roles.includes(name);
const disabled=name=>role(name)?'':`disabled title="需要 ${name} 角色"`;
const table=(heads,rows)=>`<div class="table-wrap"><table><thead><tr>${heads.map(h=>`<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows.length?rows.map(row=>'<tr>'+row.map(cell=>`<td>${cell}</td>`).join('')+'</tr>').join(''):`<tr><td colspan="${heads.length}" class="empty">暂无记录；请先完成上一步。</td></tr>`}</tbody></table></div>`;
function notify(message,error=false){clearTimeout(noticeTimer);$('#notice').textContent=message;$('#notice').className=error?'error':'';noticeTimer=setTimeout(()=>{$('#notice').textContent='';},error?15000:6000);}
async function api(path,body){
  const fingerprint=path+JSON.stringify(body),key=pendingKeys.get(fingerprint)??crypto.randomUUID();
  if(body)pendingKeys.set(fingerprint,key);
  const response=await fetch('/api'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':key},...(body?{body:JSON.stringify(body)}:{})});
  // A rejected credential invalidates the whole local session, even when the
  // error body is unavailable. A 403 only denies this operation, not identity.
  if(response.status===401){clearSession();$('#login-error').textContent='登录已失效，请使用当前部署分配给本人的有效令牌或 credential.json 重新登录。';$('#login-error').hidden=false;}
  const result=await response.json();
  if(!response.ok||result.data?.success===false)throw new Error(result.error?.message??result.data?.errors?.map(e=>e.message).join('; ')??'请求失败');
  pendingKeys.delete(fingerprint);return result.data??result;
}
async function run(task){if(busy)return;busy=true;const controls=['#logout','#access-file','#login-form button','#refresh'].map($).filter(Boolean),previous=controls.map(c=>c.disabled);controls.forEach(c=>c.disabled=true);$('#workspace').setAttribute('aria-busy','true');try{await task();}catch(error){notify(error.message,true);}finally{busy=false;controls.forEach((c,i)=>c.disabled=previous[i]);$('#workspace').setAttribute('aria-busy','false');}}
async function refresh(){state=await api('/state');if(state.mode!=='native-open-foundry')throw new Error('此页面只能连接原生 Open Foundry 平台，不能连接旧聚合扩展');if(!items('Matter').some(m=>m._id===selected))selected=items('Matter')[0]?._id??'';await loadDetail();render();}
async function loadDetail(){detail=selected?await api('/objects/Matter/'+encodeURIComponent(selected)):null;}
async function command(name,input){const result=await api('/plus/'+name,input);await refresh();notify('已完成：'+name+' · 原生回执 '+result.receipt?._id);return result;}
function bind(id,fn){$(id)?.addEventListener('click',()=>void run(fn));}
function matterButton(m){return `<button class="object-link" data-matter="${escape(m._id)}">${escape(m.matterNumber)}</button>`;}
function bindObjectLinks(){document.querySelectorAll('[data-matter]').forEach(button=>button.addEventListener('click',()=>void run(async()=>{selected=button.dataset.matter;view='objects';await loadDetail();render();})));}
function evidence(){return items('Observation').filter(o=>detail?.links.some(l=>l._toId===o._id&&l._type==='MatterObservation'));}
function simulations(){return items('SimulationRun').filter(s=>s.matterId===selected);}
function selectedSimulation(){return simulations().find(s=>s._id===lastSimulation)??simulations().at(-1);}
function render(){
  $('nav').innerHTML=views.map(([id,label],i)=>`<button data-view="${id}" class="${view===id?'active':''}" aria-current="${view===id?'page':'false'}"><span>0${i+1}</span>${label}</button>`).join('');
  document.querySelectorAll('[data-view]').forEach(button=>button.onclick=()=>{view=button.dataset.view;render();});
  $('#heading').textContent=views.find(([id])=>id===view)[1];
  $('#login').hidden=!!principal;$('#workspace').hidden=!principal;$('#logout').hidden=!principal;
  $('#identity').textContent=principal?principal.id+' / '+principal.roles.join(', '):'尚未登录';
  if(!principal||!state){$('#content').innerHTML='';$('#matter-select').innerHTML='';$('#object-context').textContent='';return;}
  $('#matter-select').innerHTML=items('Matter').map(m=>`<option value="${escape(m._id)}" ${m._id===selected?'selected':''}>${escape(m.matterNumber+' · '+m.title)}</option>`).join('')||'<option value="">请先接入数据</option>';
  $('#object-context').textContent=current()?`${current().currentState} · 版本 ${current()._version}\n${selected}`:'所有工作台读取同一原生对象';
  ({data:renderData,ontology:renderOntology,objects:renderObjects,analysis:renderAnalysis,scenarios:()=>engineering('scenarios'),actions:renderActions,learning:()=>engineering('learning'),governance:renderGovernance})[view]();
  bindObjectLinks();
}
function engineering(kind){renderEngineering(kind,{state,items,current,evidence,simulations,selectedSimulation,role,run,notify,command,setSimulation:id=>{lastSimulation=id;render();},go:id=>{view=id;render();}});}
function renderData(){
  const rows=Array.from({length:4},(_,i)=>({matterNumber:'PLUS-'+new Date().toISOString().slice(0,10)+'-'+(i+1),title:'合成留存审查示例 '+(i+1),jurisdiction:'DEMO',currentState:'EVIDENCE_COMPLETE',source:'demo-upload/row-'+(i+1),evidence:'合成证据摘要：合同与通知已收到，等待独立核验。',exposure:100+i*50}));
  $('#content').innerHTML=`<section class="panel"><h2>接入新数据</h2><p>JSON 数组或带表头的 CSV，每批最多 50 条。先检查字段建议；只有批准发布过的扩展属性才会写入对象。</p><div class="row"><label>读取本地文件<input id="file-input" type="file" accept=".json,.csv"></label><label>批次来源<input id="batch-source" value="user-upload/demo-batch"></label></div><label>待导入数据<textarea id="rows" rows="10">${escape(json(rows))}</textarea></label><div class="row"><button id="suggest">检查字段与映射</button><button id="import" class="primary" ${disabled('investigator')}>导入到原生本体</button></div><label>可编辑字段映射（目标属性 → 输入列名）<textarea id="mapping" rows="3">${escape(json(mapping))}</textarea></label><div id="mapping-result"></div></section><section class="panel"><h2>导入批次与来源</h2>${table(['来源','质量检查','身份','时间'],items('ImportBatch').map(b=>[escape(b.source),pretty(JSON.parse(b.reportJson)),escape(b.createdBy),escape(b.createdAt)]))}</section>`;
  $('#file-input').onchange=()=>void run(async()=>{const file=$('#file-input').files[0];if(!file)return;if(file.size>500000)throw new Error('演示文件最大 500 KB');const text=await file.text();$('#rows').value=json(file.name.endsWith('.csv')?csv(text):JSON.parse(text));$('#batch-source').value='upload:'+file.name;});
  bind('#suggest',async()=>{const result=await api('/plus/suggestMapping',{rows:JSON.parse($('#rows').value)});mapping=result.mapping;suggestion=result.suggestion;$('#mapping').value=json(mapping);$('#mapping-result').innerHTML=`<div class="callout">${escape(result.method)}<br>建议尚未发布，不会自动修改本体。</div>${pretty(result.suggestion)}`;});
  bind('#import',async()=>{mapping=JSON.parse($('#mapping').value);await command('importBatch',{rows:JSON.parse($('#rows').value),mapping,source:$('#batch-source').value});view='objects';render();});
}
function csv(text){let rows=[],row=[],cell='',quote=false;for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quote&&text[i+1]==='"'){cell+='"';i++;}else quote=!quote;}else if(c===','&&!quote){row.push(cell);cell='';}else if((c==='\n'||c==='\r')&&!quote){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);if(row.some(Boolean))rows.push(row);row=[];cell='';}else cell+=c;}if(quote)throw new Error('CSV 引号未闭合');row.push(cell);if(row.some(Boolean))rows.push(row);const headers=rows.shift();if(!headers||new Set(headers).size!==headers.length)throw new Error('CSV 表头为空或重复');return rows.map(values=>{if(values.length!==headers.length)throw new Error('CSV 行列数不一致');return Object.fromEntries(headers.map((h,i)=>[h,values[i]]));});}
function renderOntology(){
  const definition=suggestion?.fields?.length?suggestion:{type:'Matter',fields:[{name:'exposure',type:'Float'}]};
  $('#content').innerHTML=`<section class="panel"><h2>领域模型 · 发布版本 ${escape(state.plus.ontology.version)}</h2><div class="network"><span class="node">Matter</span><span class="edge">MatterObservation →</span><span class="node">Observation</span><span class="edge">核验 →</span><span class="node">SimulationRun</span><span class="edge">提案 →</span><span class="node">TransitionProposal</span><span class="edge">ProposalReview →</span><span class="node">HumanReview</span><span class="edge">ReviewFeedback →</span><span class="node">FeedbackEvent</span></div><p class="muted">原生链接与推演的 ID 血缘共同可追溯。下面显示平台实际定义，不是预制图。</p>${table(['对象类型','实际属性'],state.ontology.objectTypes.map(t=>[escape(t.name),t.fields.map(f=>`<code>${escape(f.name)}: ${escape(f.type.name)}</code>`).join(' · ')]))}</section><div class="grid"><section class="panel"><h2>受控属性编辑</h2><p>当前支持 Matter / Observation 的新增可空标量属性。禁止删除、改名、修改已发布属性类型。</p><label>本体建议（可修改）<textarea id="definition" rows="8">${escape(json(definition))}</textarea></label><div class="row"><button id="draft" ${disabled('data_reviewer')}>校验并保存草稿</button></div></section><section class="panel"><h2>检查与批准</h2><p>由不同身份的 model_owner 批准；批准定义会应用到原生 SPI，重启后恢复。</p>${table(['草稿','定义','状态','操作'],items('OntologyDraft').map(d=>[escape(d.createdBy),pretty(JSON.parse(d.definitionJson)),badge(d.status),d.status==='DRAFT'?`<button data-publish-draft="${d._id}" ${disabled('model_owner')}>批准发布</button>`:escape(d.approvedBy)]))}</section></div>`;
  $('#content .network').innerHTML=state.ontology.linkTypes.map(l=>`<div class="row"><span class="node">${escape(l.from)}</span><span class="edge">${escape(l.name)} →</span><span class="node">${escape(l.to)}</span></div>`).join('');
  $('#content').insertAdjacentHTML('beforeend',`<section class="panel"><h2>原生动作定义与开放边界</h2><p>旧动作定义仅供领域参考，执行入口继续关闭。NativePlusCommand 只接受服务端白名单操作，不接受客户端动作计划。</p>${table(['动作','参数','可执行入口'],state.ontology.actionTypes.map(a=>[escape(a.name),a.fields.map(f=>escape(f.name)).join(' · '),a.name.startsWith('Native')?'专用受治理接口':'已停用']))}</section>`);
  bind('#draft',async()=>{await command('draftOntology',JSON.parse($('#definition').value));});
  document.querySelectorAll('[data-publish-draft]').forEach(b=>b.onclick=()=>void run(()=>command('publishOntology',{id:b.dataset.publishDraft})));
}
function renderObjects(){
  const m=current();
  $('#content').innerHTML=`<section class="panel"><div class="row"><h2>原生对象</h2><label>搜索事项<input id="object-search" placeholder="编号、标题或当前状态"></label><label>查看对象类型<select id="type-select">${state.ontology.objectTypes.map(t=>`<option>${escape(t.name)}</option>`).join('')}</select></label></div><div id="object-table"></div></section>${m?`<section class="panel"><h2>${escape(m.title)} ${badge('v'+m._version)}</h2><p>${escape(m.summary??'原生业务对象；证据与动作通过 ID 关联。')}</p><div class="metrics"><div class="metric"><strong>${escape(m.status)}</strong><span>业务处理状态</span></div><div class="metric"><strong>${evidence().length}</strong><span>关联证据</span></div><div class="metric"><strong>${detail.history.length}</strong><span>历史版本</span></div></div><h3>证据与核验</h3>${table(['来源','摘要','核验','操作'],evidence().map(o=>[escape(o.source),escape(o.summary),badge(o.verified?'VERIFIED':'UNVERIFIED'),o.verified?escape(o.verifiedBy):`<button data-verify="${o._id}" ${disabled('data_reviewer')}>独立核验证据</button>`]))}<details><summary>对象属性与原生链接</summary>${pretty({object:detail.object,links:detail.links})}</details><h3>状态历史</h3>${table(['版本','状态','业务状态','更新时间'],detail.history.filter(Boolean).map(h=>[badge(h._version),escape(h.currentState),escape(h.status),escape(h._updatedAt)]))}</section>`:''}`;
  const show=()=>{const type=$('#type-select').value,q=$('#object-search').value.toLowerCase();const rows=items(type).filter(o=>JSON.stringify(o).toLowerCase().includes(q));$('#object-table').innerHTML=type==='Matter'?table(['编号','标题','状态','版本'],rows.map(o=>[matterButton(o),escape(o.title),badge(o.currentState),String(o._version)])):table(['ID','版本','属性'],rows.map(o=>[escape(o._id),String(o._version),`<details><summary>展开对象</summary>${pretty(o)}</details>`]));bindObjectLinks();};show();$('#object-search').oninput=show;$('#type-select').onchange=show;
  document.querySelectorAll('[data-verify]').forEach(b=>b.onclick=()=>void run(async()=>{const o=items('Observation').find(o=>o._id===b.dataset.verify);await api('/actions/NativeVerifyObservation',{observation:o._id,expectedVersion:o._version});await refresh();notify('证据已由 '+principal.id+' 核验');}));
}
function renderAnalysis(){
  $('#content').innerHTML=`<section class="panel"><h2>查询当前对象事实</h2><p>有限自然语言入口编译到只读查询，不执行任意代码或写入。支持：全部事项、未核验、高风险、待审批。</p><div class="row"><label>分析问题<input id="query" value="${escape(analysis?.query??'未核验')}"></label><button id="analyse" class="primary">运行分析</button></div></section><section class="panel"><h2>分析结果与下钻</h2>${analysis?`<div class="row">${Object.entries(analysis.groups).map(([name,count])=>`<div class="metric"><strong>${count}</strong><span>${escape(name)}</span></div>`).join('')}</div>${table(['对象','标题','状态','来源版本'],analysis.rows.map(m=>[matterButton(m),escape(m.title),badge(m.currentState),String(m._version)]))}<p class="muted">结果由 ${escape(analysis.tool)} 实时查询；点击对象下钻证据。</p>`:'<p class="empty">运行查询后显示真实结果。</p>'}</section>`;
  bind('#analyse',async()=>{analysis=await api('/plus/analyse',{query:$('#query').value});render();});
}
function renderActions(){
  const ids=new Set(detail?.links.filter(l=>l._type==='MatterProposal').map(l=>l._toId));const proposals=items('TransitionProposal').filter(p=>ids.has(p._id));
  $('#content').innerHTML=`<section class="panel"><h2>规则、审批与执行</h2><p>不同人员核验和审批。服务端检查角色、原生对象绑定、证据版本和状态冲突；原生事务写回事实。</p><label>审批意见<input id="review-note" value="已检查证据、假设和业务规则"></label>${table(['提案','目标与依据','状态','审批'],proposals.map(p=>[escape(p.title)+'<br><code>'+escape(p.proposedBy)+'</code>',escape(p.fromState+' → '+p.toState)+'<br>'+escape(p.gateReason??''),badge(p.status),p.status==='PENDING'?`<div class="row"><button data-review="${p._id}" data-decision="APPROVE" ${disabled('case_reviewer')}>批准并执行</button><button data-review="${p._id}" data-decision="REJECT" class="danger" ${disabled('case_reviewer')}>拒绝提案</button></div>`:'已完成']))}<details><summary>原生审批记录</summary>${pretty(items('HumanReview'))}</details></section><section class="panel"><h2>执行后反馈</h2><p>审批不自动成为训练真值。只有记录了后续真实／合成演示结果，经另一身份核验和隐私确认后才具备反馈资格。</p><button id="goto-learning">进入学习与模型工作台</button></section>`;
  document.querySelectorAll('[data-review]').forEach(b=>b.onclick=()=>void run(async()=>{const p=items('TransitionProposal').find(x=>x._id===b.dataset.review);await api('/actions/NativeReviewTransition',{matter:selected,proposal:p._id,observation:p.basisObservationId,expectedVersion:current()._version,decision:b.dataset.decision,note:$('#review-note').value});await refresh();notify('动作已执行，查看对象历史与治理回执');}));
  bind('#goto-learning',async()=>{view='learning';render();});
}
function renderGovernance(){
  $('#content').innerHTML=`<section class="panel"><h2>运行边界与恢复</h2><div class="callout warning">当前为单示范租户的远端独立工程 Demo，通过 SSH 隧道访问。不是生产多租户 / 高可用系统。事务回执与业务事实原子提交；完整审计为提交后追加，不是外部 WORM。</div><div class="row"><button id="health">检查规则服务状态</button><span id="health-result"></span></div>${pretty(state.capabilities)}<p>CEL 不可用时动作失败且不写事实；重启加载同一原生数据库。已批准本体定义会在读取前与启动时重新投影。原生注册表选择不可变模型工件；训练不能直接发布。反馈撤回会限制依赖它的模型，需回滚到干净版本。模型服务不可用时不使用模拟结果。</p></section><section class="panel"><h2>原生事务回执</h2>${table(['动作','真实身份','结果对象','Trace'],items('NativeCommandReceipt').slice().reverse().map(r=>[escape(r.actionName),escape(r.actorId),escape(r.resultType)+'<br><code>'+escape(r.resultId)+'</code>',escape(r.traceId)]))}</section><section class="panel"><h2>原生审计</h2>${table(['时间','身份','动作','结果'],state.audit.map(a=>[escape(a.timestamp),escape(a.actor.id),escape(a.operation.actionType),badge(a.detail.result)]))}<details><summary>完整审计记录</summary>${pretty(state.audit)}</details></section>`;
  bind('#health',async()=>{const health=await api('/health');$('#health-result').textContent=health.ok?'Go CEL 就绪':'规则服务故障';});
}
let accessCredentials=[];
function clearSession(){
  token='';principal=null;state=null;detail=null;selected='';view='data';
  mapping={};suggestion=null;analysis=null;lastSimulation='';accessCredentials=[];pendingKeys.clear();
  $('#login-form').reset();$('#access-file').value='';$('#access-role').innerHTML='<option>先读取访问文件</option>';$('#access-role').disabled=true;
  $('#access-info').textContent='未保留上一会话的凭据，请选择分配给本人的有效访问文件。';render();
}
$('#access-file').onchange=()=>void run(async()=>{const file=$('#access-file').files[0];if(!file)return;accessCredentials=[];$('#access-role').innerHTML='<option>先读取访问文件</option>';$('#access-role').disabled=true;$('#login-form input[name=token]').value='';$('#access-info').textContent='正在检查访问文件；服务器仍将独立校验身份。';try{if(file.size>50000)throw new Error('访问文件过大');const data=parseAccessFile(await file.text());accessCredentials=data.credentials;$('#access-role').innerHTML=accessCredentials.map((c,i)=>`<option value="${i}">${escape(c.role+' / '+c.id)}</option>`).join('');$('#access-role').disabled=false;$('#access-info').textContent=(data.kind==='PERSONAL'?'已读取个人凭据。':'已读取 Demo 访问文件；请选择分配给本人的身份。')+'有效期：'+data.expiresAt+'。服务器仍将验证令牌。';$('#access-role').dispatchEvent(new Event('change'));}catch(error){$('#access-info').textContent='读取失败，未保留上一次文件中的令牌。';throw error;}finally{$('#access-file').value='';}});
$('#access-role').onchange=()=>{$('#login-form input[name=token]').value=accessCredentials[Number($('#access-role').value)]?.token??'';};
$('#login-form').onsubmit=event=>{event.preventDefault();const form=event.currentTarget;void run(async()=>{token=String(new FormData(form).get('token')??'').trim().replace(/^Bearer\s+/i,'').trim();$('#login-error').hidden=true;try{principal=await api('/me');await refresh();form.reset();accessCredentials=[];$('#access-role').innerHTML='<option>先读取访问文件</option>';$('#access-role').disabled=true;}catch(error){clearSession();$('#login-error').textContent=error.message+'。请使用当前部署分配给本人的有效令牌或 credential.json，不是 tokenHash；过期或撤销凭据需管理员重新签发。';$('#login-error').hidden=false;throw error;}});};
$('#logout').onclick=()=>{clearSession();$('#login-error').hidden=true;};
$('#refresh').onclick=()=>void run(refresh);
$('#matter-select').onchange=()=>void run(async()=>{selected=$('#matter-select').value;lastSimulation='';await loadDetail();render();});
render();

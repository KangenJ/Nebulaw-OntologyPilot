const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const titles={host:'当前宿主',audit:'授权审计',jobs:'持久作业',object:'当前对象提交历史'};
export function createNativeGovernanceWorkbench({document,api,run,isBusy,getPrincipal,getDetail}){
  const $=s=>document.querySelector(s);let identity='',generation=0,mode='host',value,error='',after;
  const context=()=>JSON.stringify([getPrincipal()?.tenantId,getPrincipal()?.id,[...(getPrincipal()?.roles??[])].sort(),getDetail()?.reference]);
  function reset(){generation++;identity='';mode='host';value=undefined;error='';after=undefined;}
  function sync(){if(identity!==context()){reset();identity=context();}}
  function validate(v){if(v?.schema!=='plus-governance-'+mode+'-v1'||v.readOnly!==true||v.predictionReady!==false||v.executionAuthorized!==false||v.qualification!=='NOT_CHECKED'||!Number.isFinite(Date.parse(v.observedAt)))throw Error('INVALID_GOVERNANCE_RESPONSE');
    if(mode==='host'){if(v.sample!=='CURRENT_PROCESS_NOT_CLUSTER_HEALTH'||!Array.isArray(v.workers)||v.workers.length!==5||new Set(v.workers.map(w=>w.key)).size!==5)throw Error('INVALID_GOVERNANCE_RESPONSE');}
    else if(!Array.isArray(v.items)||v.items.length>25||typeof v.hasMore!=='boolean'||v.hasMore!==(v.nextAfter!==null)||v.nextAfter!==null&&typeof v.nextAfter!=='string')throw Error('INVALID_GOVERNANCE_RESPONSE');
    if(mode==='object'&&JSON.stringify(v.root)!==JSON.stringify(getDetail()?.reference))throw Error('INVALID_GOVERNANCE_RESPONSE');return v;
  }
  function load(next=false){if(isBusy())return;sync();if(mode==='object'&&!getDetail()?.reference)return;
    const g=generation,c=context(),cursor=next?value?.nextAfter:undefined;if(next&&!cursor)return;after=cursor;value=undefined;error='';render();
    const q=mode==='host'?{}:{limit:'25',...(after?{after}:{}),...(mode==='object'?{rootType:getDetail().reference.type,rootId:getDetail().reference.id}:{})};
    return run(async epoch=>{try{const v=await api('/governance/'+mode+(Object.keys(q).length?'?'+new URLSearchParams(q):''),epoch);
      if(g!==generation||c!==context())return;value=validate(v);
    }catch(e){if(g===generation&&c===context())error=String(e.message);throw e;}finally{if(g===generation&&c===context())render();}});
  }
  const cell=v=>'<td>'+escape(v??'—')+'</td>';
  function auditCells(a){return [a.timestamp,a.actorId,a.actionType??a.operation,a.result,a.errorCode,a.traceId].map(cell).join('');}
  function render(){sync();const r=getDetail()?.reference;
    let table='';if(value){if(mode==='host')table='<table><thead><tr><th>后台进程</th><th>状态</th><th>最近检查</th><th>错误码</th><th>本进程处理数</th><th>待修复投递</th></tr></thead><tbody>'+value.workers.map(w=>'<tr>'+[w.key,w.status,w.lastRunAt,w.lastError,w.processed,w.outboxFailed].map(cell).join('')+'</tr>').join('')+'</tbody></table>';
      else if(mode==='jobs')table='<table><thead><tr><th>原生作业</th><th>类型</th><th>状态</th><th>版本</th><th>尝试次数</th><th>提交人</th><th>错误码</th><th>租约截止</th></tr></thead><tbody>'+value.items.map(j=>'<tr>'+[j.id,j.kind,j.status,j.version,j.attempts,j.principalId,j.errorCode,j.leaseUntil].map(cell).join('')+'</tr>').join('')+'</tbody></table>';
      else table='<table><thead><tr>'+(mode==='object'?'<th>原生提交</th><th>投递状态</th>':'')+'<th>时间</th><th>主体</th><th>操作</th><th>结果</th><th>错误码</th><th>追踪号</th></tr></thead><tbody>'+value.items.map(a=>'<tr>'+(mode==='object'?cell(a.id)+cell(a.status)+auditCells(a.audit):auditCells(a))+'</tr>').join('')+'</tbody></table>';
    }
    $('#content').innerHTML=`<section class="panel"><h2>原生治理与运维</h2><p>当前对象：${escape(r?r.type+' / '+r.id+' / v'+r.version:'未选择')}。读取权限独立授予；角色名称不代表全平台审计权限。</p><label>查看范围<select id="governance-mode">${Object.entries(titles).map(([k,t])=>`<option value="${k}" ${k===mode?'selected':''}>${t}</option>`).join('')}</select></label><button id="governance-load" ${mode==='object'&&!r?'disabled':''}>读取当前记录</button>${error?'<p role="alert" class="error">'+escape(error)+'</p>':''}<p>仅观察，不重试、取消、批准或执行任何作业。未知结果请在原工作台按原请求恢复，不能换键重提。</p></section>
      <section class="panel"><h2>${escape(titles[mode])}</h2><p>${mode==='host'?'状态来自当前服务进程，未采样显示为空；不代表集群健康、模型就绪或实时 CPU/内存测量。':mode==='object'?'仅展示当前对象被原生成功提交影响的记录及审计投递状态；未提交的失败不冒充对象历史。':mode==='jobs'?'这是原生持久状态，不是当前模型资格或计算确已停止的证明。租约过期与底层计算停止是不同状态。':'仅展示明确授权主体的审计摘要；无记录不证明没有其他主体的操作。'}</p>${value?'<p>观察时间：'+escape(value.observedAt)+'；后续操作仍须重新鉴权。</p>':'<p>尚未读取或上次读取失败，不显示预置或旧结果。</p>'}<div class="table-wrap">${table}</div>${value&&mode!=='host'?'<p>'+(!value.items.length?'当前授权范围无记录。':'按原生键分页；刷新读取新记录。')+'</p><button id="governance-next" '+(!value.hasMore?'disabled':'')+'>下一页</button>':''}<details><summary>恢复原则</summary><p>FAILED / DEGRADED：按追踪号和原作业定位；先核对原回执、权限、来源资格、租约与已完成副作用。配置或数据问题修复后，使用原工作台允许的有界恢复。此页面不提供清空审计或绕过审批的修复按钮。</p></details></section>`;
    $('#governance-mode').onchange=()=>{if(isBusy())return;mode=$('#governance-mode').value;generation++;value=undefined;after=undefined;error='';render();};
    $('#governance-load').onclick=()=>void load();const next=$('#governance-next');if(next)next.onclick=()=>void load(true);
  }
  return {render,reset,load};
}

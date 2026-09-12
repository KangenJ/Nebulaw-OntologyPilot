const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pretty=value=>'<pre>'+escape(JSON.stringify(value,null,2))+'</pre>';
const roles={LATENT:'待估计现实状态',OBSERVATION:'报告/观察',CONTEXT:'上下文',FACT:'已知事实',CONTROL:'控制输入',RULE_DERIVED:'规则派生（非现实真值）'};

// Read-only view of native compiled contracts. No dimensions inferred from
// object field counts, no client approval or model-readiness calculation.
export function createNativeParameterView({document,api,run,isBusy,onRender}){
  const $=selector=>document.querySelector(selector);let index,selected,error='',generation=0;
  function reset(){generation++;index=undefined;selected=undefined;error='';}
  const current=local=>{if(local!==generation)throw Object.assign(Error('参数会话已变化'),{discarded:true});};
  function markup(){
    const m=selected;
    return `<section class="panel"><h2>Plus 本体参数清单</h2><p>从当前授权范围发现已登记机制。只读取原生编译定义；此页面不会训练、批准模型或修改本体。</p><button id="parameters-refresh">读取可见机制</button>${error?'<p class="error">'+escape(error)+'</p>':''}${index?`<div class="table-wrap"><table><thead><tr><th>机制 / 根对象</th><th>原生修订</th><th>查看</th></tr></thead><tbody>${index.items.map(item=>`<tr><td>${escape(item.key)} / ${escape(item.rootType)}</td><td>${escape(item.revision)} · ${escape(item.status)}</td><td><button data-parameter-key="${escape(item.key)}" ${item.status==='PUBLISHED'?'':'disabled'}>审阅参数</button></td></tr>`).join('')||'<tr><td colspan="3">当前没有已登记且可读的机制；不会自动创建或选用样例。</td></tr>'}</tbody></table></div>`:'<p>尚未查询，不沿用旧身份的机制信息。</p>'}
      ${m?`<h3>${escape(m.definition.title)} · ${escape(m.definition.key)} / r${escape(m.definition.revision)}</h3><p>清单摘要 ${escape(m.contentHash)}；原生定义 ${escape(m.definition.reference.id)} / v${escape(m.definition.reference.version)}。定义校验不代表模型就绪。</p><details><summary>本体、定义与权限版本</summary>${pretty({definition:m.definition,ontology:m.ontology,policyHash:m.policyHash,currentPolicyHash:m.currentPolicyHash})}</details><div class="table-wrap"><table><thead><tr><th>变量及角色</th><th>本体来源</th><th>类型、支持与未知</th><th>时间、缺失与监督</th></tr></thead><tbody>${m.variables.map(variable=>`<tr><td>${escape(variable.key)}<p>${escape(roles[variable.role]??variable.role)}</p></td><td>${pretty(variable.source)}<p>${escape(variable.sensitive?'敏感字段引用；不显示对象实际值':'结构引用')}</p>${pretty({accessPolicyRef:variable.accessPolicyRef,transform:variable.transform})}</td><td>${pretty({valueType:variable.valueType,sourceType:variable.sourceType,unit:variable.unit,nullable:variable.nullable,supportInCompiledOrder:variable.support,unknownValues:variable.unknownValues})}</td><td>${pretty({time:variable.time,missingPolicy:variable.missingPolicy,verification:variable.verification})}</td></tr>`).join('')}</tbody></table></div><p>UNKNOWN 是知识不足标记，不自动成为现实状态类别。核验政策引用不表示某条数据已具备训练资格；来源和监督仍须服务端核验。</p><h3>模块与动作契约</h3><p>模块输入/输出及类别顺序来自编译契约；不是浏览器按字段排序重新生成的网络向量。</p>${pretty({moduleOrder:m.moduleOrder,modules:m.modules,actions:m.actions})}<h3>布局、预算与决策假设</h3>${pretty({layout:m.layout,budget:m.budget,utility:m.utility,scope:m.scope})}<p>联合状态支持数 ${escape(m.layout.jointStateCount)} 不是网络参数量。特征张量、时间步监督、可训练容量、学习权重和评测结果需要独立的已批准配方/工件，本清单没有选用它们。成本与损失是审核配置，不是学得事实。</p>`:''}</section>`;
  }
  function bind(){
    $('#parameters-refresh').onclick=()=>{if(isBusy())return;void run(async epoch=>{
      const local=generation;index=undefined;selected=undefined;error='';onRender();
      try{const result=await api('/definitions',epoch);current(local);if(!result?.readOnly||!Array.isArray(result.items))throw Error('INVALID_DEFINITION_INDEX');index=result;}
      catch(e){if(!e.discarded&&local===generation)error=String(e.message);throw e;}
      finally{if(local===generation)onRender();}
    });};
    document.querySelectorAll('[data-parameter-key]').forEach(button=>button.onclick=()=>{if(isBusy())return;const key=button.dataset.parameterKey;if(!index?.items.some(item=>item.key===key&&item.status==='PUBLISHED'))return;
      void run(async epoch=>{
        const local=generation;selected=undefined;error='';onRender();
        try{
          const value=await api('/definitions/'+encodeURIComponent(key)+'/parameters',epoch);current(local);
          if(value?.schema!=='plus-parameter-manifest-v1'||value.definition?.key!==key||value.readOnly!==true||value.predictionReady!==false||value.executionAuthorized!==false)throw Error('INVALID_PARAMETER_MANIFEST');selected=value;
        }catch(e){if(!e.discarded&&local===generation)error=String(e.message);throw e;}
        finally{if(local===generation)onRender();}
      });
    });
  }
  return {markup,bind,reset};
}

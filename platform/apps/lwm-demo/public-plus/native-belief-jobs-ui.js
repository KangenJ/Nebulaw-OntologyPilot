const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v),key=v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),version=v=>Number.isSafeInteger(v)&&v>0;
const terminal=v=>['SUCCEEDED','FAILED','STALE','CANCELLED'].includes(v);
const exact=(v,fields)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...fields].sort().join(',');
const basisValid=v=>exact(v,['key','episodeId','authorizationId','snapshotId'])&&key(v.key)&&[v.episodeId,v.authorizationId,v.snapshotId].every(id);
const fail=()=>{throw Error('INVALID_BELIEF_WORKBENCH_RESPONSE');};

// Submitter UI only. All current qualification and computation remains native.
// Reload can only reconcile the original references; never auto-post, claim,
// run, fabricate a result, silently authorize or fall back to manual replay.
export function createNativeBeliefJobs({document,api,run,isBusy,getPrincipal,getAuthorization,getSnapshot,getStorage=()=>globalThis.sessionStorage}){
  const $=s=>document.querySelector(s);let bound='',generation=0,bookmark,proposal,job,basis,current,error='',recoveryError=false;
  const actor=()=>getPrincipal()?.id&&getPrincipal()?.tenantId?JSON.stringify([getPrincipal().tenantId,getPrincipal().id,[...(getPrincipal().roles??[])].sort()]):'';
  const slot=()=> 'plus.belief-intent.v1:'+bound;
  function reset(){generation++;bound='';bookmark=proposal=job=basis=current=undefined;error='';recoveryError=false;}
  function sync(){const next=actor();if(next===bound)return;reset();bound=next;if(!bound)return;
    try{const raw=getStorage()?.getItem(slot());if(raw!=null){const v=JSON.parse(raw);
      if(!exact(v,['schema','actor','basis'])||v.schema!=='plus-belief-intent-v1'||v.actor!==bound||!basisValid(v.basis))throw Error('bad bookmark');bookmark=v;basis=v.basis;
    }}catch{recoveryError=true;error='原重放请求标记不可读，已停止新提交；请保留标记并核对原请求。';}
  }
  const check=(g,p)=>{if(g!==generation||p!==actor()||p!==bound)throw Object.assign(Error('重放身份已变化'),{discarded:true});};
  function action(fn){if(isBusy())return;sync();if(!bound)return;const g=generation,p=bound;
    return run(async epoch=>{error='';try{await fn(epoch,()=>check(g,p));}catch(e){if(!e.discarded&&g===generation)error=String(e.message);throw e;}finally{if(g===generation)render();}});
  }
  function validateLookup(v,b){
    if(v?.schema!=='plus-belief-job-lookup-v1'||v.readOnly!==true||v.absenceIsNotCancellation!==true||v.predictionReady!==false||v.replayAuthorized!==false
      ||Object.keys(b).some(k=>v[k]!==b[k]))fail();
    const j=v.item;if(j!==null&&(!id(j?.id)||!version(j.version)||!Number.isSafeInteger(j.attempts)||j.attempts<0||!hash(j.commandHash)
      ||!Number.isSafeInteger(j.expectedVersion)||j.expectedVersion<0||!['PENDING','LEASED','SUCCEEDED','FAILED','STALE','CANCELLED'].includes(j.status)
      ||j.predictionReady!==false||j.qualification!=='NOT_CHECKED'||(j.status==='SUCCEEDED'? !id(j.recordedBelief?.beliefId)||!id(j.recordedBelief.headId)||!version(j.recordedBelief.generation):j.recordedBelief!==null)))fail();
    return j;
  }
  function save(b){const storage=getStorage();if(!storage||storage.getItem(slot())!==null)throw Error('无法安全保存原重放意图，未提交');
    const value={schema:'plus-belief-intent-v1',actor:bound,basis:structuredClone(b)},raw=JSON.stringify(value);
    storage.setItem(slot(),raw);if(storage.getItem(slot())!==raw)throw Error('原重放意图保存未确认，未提交');bookmark=value;
  }
  async function reconcile(epoch,valid){const b=bookmark?.basis??basis;if(!b||recoveryError)return;
    current=undefined;const response=await api('/learning/belief-jobs/lookup',epoch,b);valid();job=validateLookup(response,b);basis=structuredClone(b);
    if(!job){error='暂未找到原作业，不代表原提交已取消。请继续查原请求，不要创建替代计算。';return;}
    if(bookmark&&terminal(job.status)){getStorage().removeItem(slot());bookmark=undefined;proposal=undefined;}
  }
  function selected(){const a=getAuthorization(),s=getSnapshot(),input=s?.snapshot?.compiledInput;
    if(!a||!s||a.replayAuthorized!==true||a.predictionReady!==false||!id(a.record?._id)||!id(s.snapshot?.record?._id)||!id(s.episodeId)
      ||input?.definitionHash!==a.material?.policy?.clock?.definitionHash||input?.bindingHash!==a.material.policy.clock.bindingHash)throw Error('请先核验当前在线授权并在原生过程面板选择匹配的有效快照');
    const b={key:a.record.controlKey,episodeId:s.episodeId,authorizationId:a.record._id,snapshotId:s.snapshot.record._id};if(!basisValid(b))fail();return b;
  }
  function matchesSelected(){try{const v=selected();return basis&&Object.keys(basis).every(k=>basis[k]===v[k]);}catch{return false;}}
  function prepare(){sync();if(bookmark||recoveryError)return;return action(async(epoch,valid)=>{
    const b=selected();proposal=job=current=undefined;basis=b;
    const found=await api('/learning/belief-jobs/lookup',epoch,b);valid();job=validateLookup(found,b);
    if(job){if(!terminal(job.status))save(b);return;}
    const position=await api('/learning/beliefs/'+encodeURIComponent(b.key)+'/episodes/'+encodeURIComponent(b.episodeId)+'/position',epoch);valid();
    if(position?.readOnly!==true||position.qualification!=='NOT_CHECKED'||position.predictionReady!==false||position.replayAuthorized!==false||!Number.isSafeInteger(position.expectedVersion)||position.expectedVersion<0)fail();
    if(JSON.stringify(selected())!==JSON.stringify(b))throw Error('授权或快照已变化，请重新准备');
    proposal={basis:b,command:{authorizationId:b.authorizationId,snapshotId:b.snapshotId,expectedVersion:position.expectedVersion}};
  });}
  function submit(event){event.preventDefault();sync();if(isBusy()||recoveryError||!proposal||!$('#belief-submit-confirm')?.checked)return;
    if(!bookmark){try{if(JSON.stringify(selected())!==JSON.stringify(proposal.basis))throw Error('授权或快照已变化，请重新准备');}
      catch(e){proposal=undefined;error=String(e.message);render();return;}}
    return action(async(epoch,valid)=>{
      if(!bookmark)save(proposal.basis);const command=structuredClone(proposal.command);
      const value=await api('/learning/belief-jobs',epoch,command);valid();
      if(!id(value?.id)||!version(value.version)||value.predictionReady!==false||!['PENDING','LEASED','SUCCEEDED','FAILED','STALE','CANCELLED'].includes(value.status))fail();
      await reconcile(epoch,valid);
    });
  }
  function read(){sync();if(!basis||job?.status!=='SUCCEEDED')return;return action(async(epoch,valid)=>{
    if(!matchesSelected()){current=undefined;throw Error('请重新选择并核验与原作业一致的授权及快照，再读取当前信念');}
    current=undefined;const value=await api('/learning/beliefs/'+encodeURIComponent(basis.key)+'/episodes/'+encodeURIComponent(basis.episodeId),epoch);valid();
    if(value?.predictionReady!==true||value.beliefId!==job.recordedBelief.beliefId||value.record?._id!==value.beliefId){throw Error('原作业已完成，但不是当前可用信念；请检查最新授权、输入和作业。');}
    current=value;
  });}
  function cancel(event){event.preventDefault();sync();if(!job||!['PENDING','LEASED'].includes(job.status)||!$('#belief-cancel-confirm')?.checked)return;
    return action(async(epoch,valid)=>{current=undefined;await api('/learning/belief-jobs/'+encodeURIComponent(job.id)+'/cancel',epoch,{expectedVersion:job.version});valid();await reconcile(epoch,valid);});
  }
  function render(){sync();const container=$('#belief-jobs');if(!container)return;
    if(current&&!matchesSelected())current=undefined;
    container.innerHTML=`<h2>原生快照与持久重放</h2><p>先在在线授权面板核验当前授权，再在分析过程面板选择有效快照。准备只读取原作业和CAS版本；明确提交后由固定后台worker执行。作业成功不等于预测仍然有效。</p>
      ${error?`<p class="error" role="alert">${escape(error)}</p>`:''}<button id="belief-prepare" ${bookmark||recoveryError?'disabled':''}>读取所选快照的重放准备信息</button>
      ${proposal?`<p>原生授权 ${escape(proposal.basis.authorizationId)} · 快照 ${escape(proposal.basis.snapshotId)} · CAS v${proposal.command.expectedVersion}；尚未授予新权限。</p><form id="belief-submit-form"><label><input id="belief-submit-confirm" type="checkbox" required>确认以此原生输入提交重放；不改业务事实</label><button type="submit">${bookmark?'继续同一原始提交':'提交持久重放作业'}</button></form>`:''}
      ${basis?`<p>原作业范围：${escape(basis.key)} / 过程 ${escape(basis.episodeId)} / 快照 ${escape(basis.snapshotId)}。</p>`:''}${bookmark||basis?'<button id="belief-lookup">查询原重放作业</button>':''}
      ${bookmark?'<p role="status">已保存原请求的最小引用，无令牌和预测数据。刷新后仅查原作业；未查到不表示已取消。</p>':''}
      ${job?`<p>原生作业 ${escape(job.id)} / v${job.version} · ${escape(job.status)} · 已尝试 ${job.attempts} 次。资格 NOT_CHECKED。</p>${job.status==='SUCCEEDED'?'<button id="belief-read-current">重新核验并读取当前信念</button>':''}${['PENDING','LEASED'].includes(job.status)?'<form id="belief-cancel-form"><label><input id="belief-cancel-confirm" type="checkbox" required>请求取消原作业，不撤销业务事实</label><button type="submit">取消原重放作业</button></form>':''}`:''}
      ${current?`<p role="status">本次服务端当前信念读取通过（读取时结果，非实时监控；使用前须再次核验）；未执行业务动作。</p><pre>${escape(JSON.stringify({beliefId:current.beliefId,result:current.record.payload?.result,distribution:current.record.distribution},null,2))}</pre>`:''}`;
    $('#belief-prepare').onclick=()=>void prepare();const lookup=$('#belief-lookup');if(lookup)lookup.onclick=()=>void action(reconcile);
    const form=$('#belief-submit-form');if(form)form.onsubmit=submit;const readButton=$('#belief-read-current');if(readButton)readButton.onclick=()=>void read();
    const cancelForm=$('#belief-cancel-form');if(cancelForm)cancelForm.onsubmit=cancel;
  }
  return {render,reset};
}

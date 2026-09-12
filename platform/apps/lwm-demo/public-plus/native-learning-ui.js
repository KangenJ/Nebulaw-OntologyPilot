import {createNativeModelHistory} from './native-model-history-ui.js';
import {createNativeFeedbackReview} from './native-feedback-ui.js';
import {createNativeDatasetWorkbench} from './native-dataset-ui.js';
import {createNativeFeedbackProposal} from './native-feedback-proposal-ui.js';
import {createNativeCohortProposal} from './native-cohort-proposal-ui.js';
import {createNativeEpisodeWorkbench} from './native-episode-ui.js';
import {createNativeTrainingWorkbench} from './native-training-ui.js';
import {createNativeComputeAuthorizationWorkbench} from './native-compute-authorization-ui.js';
import {createNativeSelectionJobs} from './native-selection-jobs-ui.js';
import {createNativeModelActivation} from './native-model-activation-ui.js';
import {createNativeEvaluationJobs} from './native-evaluation-jobs-ui.js';
import {createNativeEvaluationWorkbench} from './native-evaluation-ui.js';
import {createNativeDecisionJobs} from './native-decision-jobs-ui.js';
import {createNativeModelReview} from './native-model-review-ui.js';
import {createNativeReplayAuthorization} from './native-replay-authorization-ui.js';
import {createNativeBeliefJobs} from './native-belief-jobs-ui.js';
import {createNativeRuleWorkbench} from './native-rule-ui.js';
import {createNativeRecipeWorkbench} from './native-recipe-ui.js';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pretty=value=>'<pre>'+escape(JSON.stringify(value,null,2))+'</pre>';

// Native current selection discovery, not the legacy neural/demo state. No
// No automatic training/publication; explicit historical rollback uses the
// existing server-governed selection API. Metadata never grants prediction.
export function createNativeLearningWorkbench({document,api,run,isBusy,getDetail,getPrincipal=()=>null}){
  const $=selector=>document.querySelector(selector);let index,selected,error='',generation=0;
  const rules=createNativeRuleWorkbench({document,api,run,isBusy,getPrincipal});
  const recipeWorkbench=createNativeRecipeWorkbench({document,api,run,isBusy,getPrincipal});
  const replayAuthorization=createNativeReplayAuthorization({document,api,run,isBusy,getPrincipal});
  const beliefJobs=createNativeBeliefJobs({document,api,run,isBusy,getPrincipal,getAuthorization:()=>replayAuthorization.authorizationContext(),getSnapshot:()=>episodes.snapshotContext()});
  const selectionJobs=createNativeSelectionJobs({document,api,run,isBusy,getPrincipal,onSelectionChange:()=>{index=selected=undefined;replayAuthorization.reset();beliefJobs.reset();render();}});
  const history=createNativeModelHistory({document,api,run,isBusy,getPrincipal,onSubmitRollback:command=>selectionJobs.submit(command)});
  const activation=createNativeModelActivation({document,api,run,isBusy,getPrincipal,onSubmit:command=>selectionJobs.submit(command)});
  const feedback=createNativeFeedbackReview({document,api,run,isBusy,getDetail,getPrincipal});
  const training=createNativeTrainingWorkbench({document,api,run,isBusy,getPrincipal,getDataset:()=>datasets.trainingContext(),getHistoryDataset:()=>datasets.trainingHistoryContext(),onJobChange:()=>evaluation.render()});
  const computeAuthorization=createNativeComputeAuthorizationWorkbench({document,api,run,isBusy,getDetail,getPrincipal});
  const evaluationJobs=createNativeEvaluationJobs({document,api,run,isBusy,getPrincipal,onResolved:()=>{evaluation.reset();evaluation.render();}});
  const evaluation=createNativeEvaluationWorkbench({document,api,run,isBusy,getPrincipal,getExecution:()=>training.evaluationContext(),onSubmit:command=>evaluationJobs.submit(command),onHistory:key=>evaluationJobs.load(key)});
  const decisionJobs=createNativeDecisionJobs({document,api,run,isBusy,getPrincipal,onResolved:()=>{review.reset();review.render();}});
  const review=createNativeModelReview({document,api,run,isBusy,getPrincipal,onSubmit:command=>decisionJobs.submit(command),onHistory:key=>decisionJobs.load(key)});
  const datasets=createNativeDatasetWorkbench({document,api,run,isBusy,getDetail,getPrincipal,onDatasetChange:()=>{training.render();computeAuthorization.render();}});
  const proposal=createNativeFeedbackProposal({document,api,run,isBusy,getDetail,getPrincipal});
  const cohorts=createNativeCohortProposal({document,api,run,isBusy,getDetail,getPrincipal});
  const episodes=createNativeEpisodeWorkbench({document,api,run,isBusy,getDetail,getPrincipal});
  function reset(){generation++;rules.reset();recipeWorkbench.reset();index=undefined;selected=undefined;error='';beliefJobs.reset();replayAuthorization.reset();history.reset();activation.reset();selectionJobs.reset();feedback.reset();datasets.reset();proposal.reset();cohorts.reset();episodes.reset();training.reset();computeAuthorization.reset();evaluation.reset();evaluationJobs.reset();review.reset();decisionJobs.reset();}
  const current=local=>{if(local!==generation)throw Object.assign(Error('模型会话已变化'),{discarded:true});};
  function render(){
    const context=getDetail(),m=selected;
    $('#content').innerHTML=`<section class="panel"><h2>原生模型与生效版本</h2><p>从当前身份获准读取的模型用途发现原生选择。登记记录不等于资格有效；点击后服务端重新检查当前模型、审批与来源。此页不自动训练、发布或授予在线推断许可。</p><p>当前对象：${escape(context?context.reference.type+' / '+context.reference.id:'尚未选择')}。这里只保留导航上下文，不据此判断模型适用性。</p><button id="models-refresh">读取可见模型用途</button>${error?'<p class="error" role="alert">'+escape(error)+'</p>':''}${index?`<div class="table-wrap"><table><thead><tr><th>模型用途 / 数据范围</th><th>原生选择登记</th><th>当前资格</th></tr></thead><tbody>${index.items.map(item=>`<tr><td>${escape(item.key)}<p>${escape(item.configuredTarget.scopeKey)} · ${escape(item.configuredTarget.classification)}</p></td><td>${item.recordedSelection?`第 ${escape(item.recordedSelection.generation)} 代 · 对象 v${escape(item.recordedSelection.version)}<br>登记状态 ${escape(item.recordedSelection.recordedReadiness)}（未检查当前资格）`:'尚未登记模型选择'}</td><td><button data-model-key="${escape(item.key)}" ${item.recordedSelection?'':'disabled'}>核验并查看当前版本</button></td></tr>`).join('')||'<tr><td colspan="3">当前身份没有可见模型用途；不会自动选择样例或扩大权限。</td></tr>'}</tbody></table></div>`:'<p>尚未查询；不会沿用旧身份的模型信息。</p>'}</section>
      ${m?`<section class="panel"><h2>${escape(m.record.controlKey)} · 第 ${escape(m.record.generation)} 代</h2><p>当前选择已通过本次服务端读取检查，仍需独立在线许可和合格事件重放。此记录不是当前业务事实，也不意味着浏览器可以执行动作。</p><p>模型工件：${escape(m.selection.release.key)}；版本来源：${escape(m.revision.payload.command.mode==='ROLLBACK'?'回滚选择':'模型选择')}。</p><div class="table-wrap"><table><thead><tr><th>血缘</th><th>原生记录</th><th>版本 / 摘要</th></tr></thead><tbody>${[['工件',m.selection.release],['独立模型决定',m.selection.decision],['本体定义',m.selection.definition]].map(([label,ref])=>`<tr><td>${label}</td><td>${escape(ref.id)}</td><td>${escape(ref.version)} / ${escape(ref.hash)}</td></tr>`).join('')}</tbody></table></div><details><summary>本次资格绑定与选择版本</summary>${pretty({target:m.selection.target,selection:{id:m.revision._id,version:m.revision._version},replayRequired:m.replayRequired,predictionReady:m.predictionReady})}</details><p>记录更新时间：${escape(m.revision.createdAt)}。页面展示的是读取时结果；后续操作仍须服务端重新核验。</p></section>`:''}
      <section class="panel"><h2>选择要检查的历史</h2>${index?.items.filter(item=>item.recordedSelection).map(item=>`<button data-history-key="${escape(item.key)}">${escape(item.key)} · 历史与回滚</button>`).join('')||'<p>先读取可见模型用途。</p>'}${index?.items.map(item=>`<button data-model-activation-key="${escape(item.key)}">${escape(item.key)} · 批准决定与发布</button><button data-selection-jobs-key="${escape(item.key)}">${escape(item.key)} · 我的选择作业</button>`).join('')??''}</section><section id="model-activation" class="panel"></section><section id="model-history" class="panel"></section><section id="selection-jobs" class="panel"></section>
      <section id="episode-workbench" class="panel"></section><section id="cohort-proposal" class="panel"></section><section id="feedback-proposal" class="panel"></section><section id="feedback-review" class="panel"></section><section id="dataset-workbench" class="panel"></section><section id="compute-authorization-workbench" class="panel"></section><section id="training-workbench" class="panel"></section><section id="evaluation-workbench" class="panel"></section><section id="evaluation-jobs" class="panel"></section><section id="model-review" class="panel"></section><section id="decision-jobs" class="panel"></section><section class="panel"><h2>学习与发布边界</h2><p>训练授权、独立模型审核与发布是不同操作。这里只显示真实原生记录；模型是否可用，以当前用途的服务端资格核验为准。单项结果不代表完整平台验收，后台测试结果不作为这里的预置模型或学习成果。</p></section>`;
    $('#content').innerHTML+=`<section class="panel">${index?.items.filter(item=>item.recordedSelection).map(item=>`<button data-replay-purpose="${escape(item.key)}">${escape(item.key)} · 在线授权与恢复</button>`).join('')??''}</section><section id="replay-authorization" class="panel"></section>`;
    $('#content').innerHTML+='<section id="belief-jobs" class="panel"></section>';
    $('#content').innerHTML+='<section id="rule-workbench" class="panel"></section>';rules.render();
    $('#content').innerHTML+='<section id="recipe-workbench" class="panel"></section>';recipeWorkbench.render();
    replayAuthorization.render();beliefJobs.render();
    document.querySelectorAll('[data-replay-purpose]').forEach(button=>{if(button.dataset.replayPurpose)button.onclick=()=>{if(index?.items.some(item=>item.key===button.dataset.replayPurpose&&item.recordedSelection))void replayAuthorization.load(button.dataset.replayPurpose);};});
    history.render();activation.render();selectionJobs.render();feedback.render();datasets.render();proposal.render();cohorts.render();episodes.render();evaluation.render();evaluationJobs.render();review.render();decisionJobs.render();
    document.querySelectorAll('[data-model-activation-key]').forEach(button=>{if(button.dataset.modelActivationKey)button.onclick=()=>{
      if(index?.items.some(item=>item.key===button.dataset.modelActivationKey))void activation.load(button.dataset.modelActivationKey);};});
    document.querySelectorAll('[data-selection-jobs-key]').forEach(button=>{if(button.dataset.selectionJobsKey)button.onclick=()=>{
      if(index?.items.some(item=>item.key===button.dataset.selectionJobsKey))void selectionJobs.load(button.dataset.selectionJobsKey);};});
    document.querySelectorAll('[data-history-key]').forEach(button=>{if(button.dataset.historyKey)button.onclick=()=>{if(index?.items.some(item=>item.key===button.dataset.historyKey&&item.recordedSelection))void history.load(button.dataset.historyKey);};});
    $('#models-refresh').onclick=()=>{if(isBusy())return;void run(async epoch=>{
      const local=generation;index=undefined;selected=undefined;error='';replayAuthorization.reset();render();
      try{const value=await api('/learning/deployments',epoch);current(local);
        if(value?.schema!=='plus-model-selection-index-v1'||value.readOnly!==true||value.predictionReady!==false||value.executionAuthorized!==false||!Array.isArray(value.items)||value.items.some(v=>v.qualification!=='NOT_CHECKED'))throw Error('INVALID_MODEL_SELECTION_INDEX');index=value;
      }catch(e){if(!e.discarded&&local===generation)error=String(e.message);throw e;}
      finally{if(local===generation)render();}
    });};
    document.querySelectorAll('[data-model-key]').forEach(button=>button.onclick=()=>{if(isBusy())return;const key=button.dataset.modelKey;
      if(!index?.items.some(item=>item.key===key&&item.recordedSelection))return;
      void run(async epoch=>{const local=generation;selected=undefined;error='';render();
        try{const value=await api('/learning/deployments/'+encodeURIComponent(key),epoch);current(local);
          if(value?.record?.controlKey!==key||value.predictionReady!==false||value.replayRequired!==true||!value.selection?.release||!value.selection.decision||!value.selection.definition||!value.revision?.payload?.command)throw Error('INVALID_MODEL_SELECTION');selected=value;
        }catch(e){if(!e.discarded&&local===generation)error=String(e.message);throw e;}
        finally{if(local===generation)render();}
      });
    });
  }
  return {render,reset};
}

import {createNativeActionWorkbench} from './native-actions-ui.js';
import {createNativeActionReviewWorkbench} from './native-action-review-ui.js';
import {createNativeActionProposalWorkbench} from './native-action-proposal-ui.js';

export function createNativeActionWorkflow(options){
  const {document,getPrincipal,isBusy}=options;let mode='execute',identity;
  const childDocument={querySelector:s=>document.querySelector(s==='#content'?'#action-workflow-content':s),querySelectorAll:s=>document.querySelectorAll(s)};
  const execution=createNativeActionWorkbench({...options,document:childDocument}),review=createNativeActionReviewWorkbench({...options,document:childDocument}),proposal=createNativeActionProposalWorkbench({...options,document:childDocument});
  function reset(){identity=undefined;mode='execute';execution.reset();review.reset();proposal.reset();}
  function render(){const p=getPrincipal(),next=JSON.stringify([p?.id,p?.tenantId,p?.roles]);if(next!==identity){reset();identity=next;mode=p?.roles?.includes('case_reviewer')&&!p.roles.includes('investigator')?'review':'execute';}
    document.querySelector('#content').innerHTML='<section class="panel"><button id="action-workflow-proposal">从原生推演创建提案</button><button id="action-workflow-review">独立审批与决定历史</button><button id="action-workflow-execute">执行与原请求恢复</button><p>提案、独立审批和执行分别受治理，不自动串行执行。</p></section><div id="action-workflow-content"></div>';
    (mode==='execute'?execution:mode==='review'?review:proposal).render();
    for(const value of ['execute','review','proposal'])document.querySelector('#action-workflow-'+value).onclick=()=>{if(isBusy())return;mode=value;render();};
  }
  return {render,reset,showProposal(){render();mode='proposal';render();}};
}

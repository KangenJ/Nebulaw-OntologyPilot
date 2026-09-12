import {validateTaskLearningPolicy} from '../../platform/apps/lwm-demo/src/task-learning.mjs';
import {validatePrivateTaskRulePolicy} from './task-rule-services.mjs';

// Deliberately only the initial installation phase. A populated execution/
// model-governance graph must use its reviewed deployment planner, not bypass
// graph validation by passing through this configuration-only entry point.
export function assertInitialLearningConfiguration(policy){
  if(!policy||policy.taskDomain?.enabled!==true||Object.keys(policy).some(k=>!['version','definitions','taskDomain','objectBrowser','taskLearning','taskRules'].includes(k)))
    throw Object.assign(Error('LEARNING_INITIAL_CONFIGURATION_REQUIRED'),{code:'LEARNING_INITIAL_CONFIGURATION_REQUIRED'});
  validateTaskLearningPolicy(policy.taskLearning);
  if(policy.taskRules!==undefined){
    const {rules}=validatePrivateTaskRulePolicy(policy);
    if(rules.enabled&&(!rules.specifications.length||!rules.grants.length||rules.grants.some(g=>g.permissions.some(p=>['rule:draft','rule:review','rule:use'].includes(p))&&(!g.sourceIds.length||!g.sourceFields.length))))
      throw Object.assign(Error('LEARNING_INITIAL_RULE_SOURCES_REQUIRED'),{code:'LEARNING_INITIAL_RULE_SOURCES_REQUIRED'});
  }
}

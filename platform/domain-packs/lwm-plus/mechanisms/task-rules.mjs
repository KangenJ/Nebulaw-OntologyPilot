import { readFileSync } from 'node:fs';
import { extendOdl, parseOdl } from '../../../packages/odl/dist/index.js';
import { taskTimedMechanismDefinition } from './task-mechanism.mjs';

/** Explicit isolated baseline/migration input, never a startup-time install. */
export function buildTaskRulesInput(previous) {
  const parsed = parseOdl(previous.odl);
  if (parsed.linkTypes.some(t => t.name === 'TaskRuleSpecificationSource')) throw new Error('TASK_RULE_BRIDGE_ALREADY_PRESENT');
  if (!['PlusRuleSpecification','RuleVersion'].every(name => parsed.objectTypes.some(t => t.name === name))) throw new Error('TASK_RULE_BRIDGE_DEPENDENCY_REQUIRED');
  return { ...structuredClone(previous), odl: extendOdl(previous.odl,readFileSync(new URL('./task-rules.odl',import.meta.url),'utf8')) };
}

/** Reviewed candidate structure, not a published definition or a learned rule.
 * Pure rule results can consume it. Statistical consumers must still reject an
 * unsupported mixed RULE structure until their explicit composition is built. */
export function taskRuleMechanismDefinition() {
  const result = taskTimedMechanismDefinition(), priority = result.definition.variables.find(v => v.key === 'priority');
  result.definition.revision = 3; result.definition.title = 'Synthetic task context and separately governed rule-derived priority';
  const recommendation = { ...structuredClone(priority), key:'recommendedPriority',role:'RULE_DERIVED' };
  // An unchanged initial prefix belongs to the native CONTEXT input, not to
  // a derived result. The result is computed at the authorized target snapshot.
  delete recommendation.time.initial;
  result.definition.variables.push(recommendation);
  result.definition.modules.push({key:'priorityRecommendation',kind:'RULE',inputs:['priority'],outputs:['recommendedPriority'],dependsOn:[],implementation:'typed-cel-rule-v1'});
  result.policy.fieldSemantics['InvestigationTask.priority'].roles.push('RULE_DERIVED');
  result.policy.implementationIds.push('typed-cel-rule-v1');
  return result;
}

/** Explicit revision 4 candidate. Registering a follow-up acquires no evidence
 * and changes no completion state. Publication and action authorization remain
 * separate native decisions; constructing this definition grants neither. */
export function taskInvestigationMechanismDefinition() {
  const result=taskRuleMechanismDefinition();
  result.definition.revision=4;
  result.definition.title='Synthetic task rules and governed information-request history';
  result.definition.actions=[{key:'requestVerification',nativeAction:'NativeRegisterInvestigationTask',effect:'INFORMATION_ONLY',parameters:{
    matter:'INPUT',expectedVersion:'SERVER',taskNumber:'INPUT',title:'INPUT',priority:'INPUT',assignee:'INPUT',instructions:'INPUT',dueAt:'INPUT',
    classification:'INPUT',commandKey:'SERVER',commandHash:'SERVER',traceId:'SERVER'}}];
  result.policy.actionNames=['NativeRegisterInvestigationTask'];
  return result;
}

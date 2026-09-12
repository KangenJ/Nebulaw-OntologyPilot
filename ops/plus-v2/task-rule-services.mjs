import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { NativeRuleRegistry, NativeRuleRuntime } from '../../platform/packages/plus-runtime/dist/index.js';
import { createRuleBackend } from '../../services/plus-engine/rule-backend.mjs';
import { createPrivateAuthorizationRevision } from './private-authority.mjs';
import { createPrivateRuleWorkbench } from './rule-workbench-services.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const exact = (v, names) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === names.length && names.every(n => Object.hasOwn(v, n));
const key = v => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(v);
const id = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const list = (v, check, max = 100, empty = false) => Array.isArray(v) && (empty || v.length > 0) && v.length <= max && v.every(check) && new Set(v).size === v.length;
const RULE_PERMISSIONS = ['rule:draft','rule:review','rule:revoke','rule:read','rule:use'];
const RESULT_PERMISSIONS = ['rule:evaluate','rule-result:read'];
export const taskRuleSourceFields = Object.freeze(['workspaceKey','ruleKey','title','versionTag','lifecycle','effectiveFrom','sourceCitation','deterministic']);
const SOURCE_TYPE = 'RuleVersion', SOURCE_LINK = 'TaskRuleSpecificationSource';
const sourceSemantics = { version: 'plus-task-rule-source-v1', sourceType: SOURCE_TYPE, sourceLink: SOURCE_LINK,
  requiredFields: [...taskRuleSourceFields], lifecycle: 'ACTIVE', deterministic: true, time: 'CURRENT_RULE_EFFECTIVE_AT_TARGET' };

// Pure shape/relationship validation shared with private operator plans.
// Does not evaluate expressions, read sources, grant approvals or require CEL.
export function validatePrivateTaskRulePolicy(raw) {
    const all = structuredClone(raw), v = all.taskRules, d = all.taskDomain;
    if (!exact(v, ['version','enabled','specifications','evaluations','grants']) || v.version !== 'plus-private-task-rules-v1' || typeof v.enabled !== 'boolean'
      || !Array.isArray(v.specifications) || v.specifications.length > 100 || !Array.isArray(v.evaluations) || v.evaluations.length > 100 || !Array.isArray(v.grants) || v.grants.length > 500
      || !d || d.enabled !== true || !d.workspaceClassifications || typeof d.workspaceClassifications !== 'object') fail('TASK_RULE_CONFIGURATION_INVALID');
    const specifications = new Set(), evaluations = new Set(), bindings = new Set();
    for (const s of v.specifications) {
      const p = s?.policy;
      if (!exact(s, ['key','workspace','policy']) || !key(s.key) || specifications.has(s.key) || !key(s.workspace) || !Object.hasOwn(d.workspaceClassifications,s.workspace)
        || !['SYNTHETIC','AUTHORIZED_REAL'].includes(d.workspaceClassifications[s.workspace])
        || !exact(p, ['version','id','definitionKeys','scopeKeys','bindings']) || p.version !== 'plus-rule-policy-v1' || !key(p.id)
        || !list(p.definitionKeys,key) || !list(p.scopeKeys,key) || !Array.isArray(p.bindings) || !p.bindings.length || p.bindings.length > 32
        || new Set(p.bindings.map(b => b?.moduleKey)).size !== p.bindings.length) fail('TASK_RULE_CONFIGURATION_INVALID');
      specifications.add(s.key);
      for (const b of p.bindings) {
        if (!exact(b,['moduleKey','sourceType','sourceLink']) || !key(b.moduleKey) || b.sourceType !== SOURCE_TYPE || b.sourceLink !== SOURCE_LINK) fail('TASK_RULE_CONFIGURATION_INVALID');
        // Source qualification must resolve to one declared purpose, never the
        // first of several scopes that happen to contain the same module.
        for (const def of p.definitionKeys) for (const scope of p.scopeKeys) {
          const identity = digest([s.workspace,def,scope,b]); if (bindings.has(identity)) fail('TASK_RULE_CONFIGURATION_INVALID'); bindings.add(identity);
        }
      }
    }
    for (const e of v.evaluations) {
      const p = e?.policy;
      if (!exact(e,['key','workspace','episodeIds','policy']) || !key(e.key) || evaluations.has(e.key) || !key(e.workspace) || !list(e.episodeIds,id,1000)
        || !Object.hasOwn(d.workspaceClassifications,e.workspace) || !['SYNTHETIC','AUTHORIZED_REAL'].includes(d.workspaceClassifications[e.workspace])
        || !exact(p,['version','id','definitionKeys','scopeKeys','classifications','specificationHashes']) || p.version !== 'plus-rule-evaluation-policy-v1' || !key(p.id)
        || !list(p.definitionKeys,key) || !list(p.scopeKeys,key) || !list(p.classifications,c => c === d.workspaceClassifications[e.workspace],1) || !list(p.specificationHashes,hash)) fail('TASK_RULE_CONFIGURATION_INVALID');
      evaluations.add(e.key);
    }
    for (const g of v.grants) {
      if (!exact(g,['principalId','requiredRoles','permissions','specificationKeys','evaluationKeys','sourceIds','sourceFields']) || !id(g.principalId) || !list(g.requiredRoles,key,32)
        || !list(g.permissions,p => [...RULE_PERMISSIONS,...RESULT_PERMISSIONS].includes(p),7)
        || !list(g.specificationKeys,k => specifications.has(k),100,true) || !list(g.evaluationKeys,k => evaluations.has(k),100,true)
        || !list(g.sourceIds,id,1000,true) || !list(g.sourceFields,f => taskRuleSourceFields.includes(f),taskRuleSourceFields.length,true)) fail('TASK_RULE_CONFIGURATION_INVALID');
    }
    return { rules: v, classifications: d.workspaceClassifications };
}

/** Code-owned RuleVersion qualification. Private policy pins exact objects,
 * fields, workspaces, definitions and evaluation episodes. No source data,
 * output, expression or permission is supplied by an HTTP caller. */
export function createPrivateTaskRuleAccess(options) {
  const { storage, tenantId, loadPolicy, clock = Date.now } = options;
  const authority = createPrivateAuthorizationRevision(options), ctx = { tenantId };
  if (typeof storage?.getObject !== 'function' || typeof clock !== 'function') fail('TASK_RULE_CONFIGURATION_INVALID');
  const load = () => validatePrivateTaskRulePolicy(loadPolicy());
  const grants = (v,p,permissions) => v.rules.enabled ? v.rules.grants.filter(g => g.principalId === p.id && g.requiredRoles.every(r => p.roles.includes(r)) && g.permissions.some(r => permissions.includes(r))) : [];
  const canRule = (v,p,permissions,k) => grants(v,p,permissions).some(g => g.specificationKeys.includes(k));
  const canResult = (v,p,permissions,k) => grants(v,p,permissions).some(g => g.evaluationKeys.includes(k));
  async function fence(p,v,epoch) { if (await authority(p) !== epoch || digest(load()) !== digest(v)) fail('TASK_RULE_AUTHORITY_STALE'); }
  async function episodeScope(v,e,episodeId) {
    const episode = await storage.getObject(ctx,'PlusEpisode',episodeId), ref = episode?.rootReference;
    if (!episode || episode._deletedAt || episode._tenantId !== tenantId || ref?.tenantId !== tenantId || ref.type !== 'InvestigationTask') return false;
    const root = await storage.getObject(ctx,'InvestigationTask',ref.id);
    return !!root && !root._deletedAt && root._tenantId === tenantId && root.workspaceKey === e.workspace
      && root.dataClassification === v.classifications[e.workspace] && episode.classification === root.dataClassification && e.policy.scopeKeys.includes(episode.scopeKey);
  }
  return { assertConfigured: () => { load(); }, authorizationRevision: authority,
    async workbenchPurposes(p) {
      const epoch=await authority(p),v=load(),items=[];
      for(const s of v.rules.specifications)if(canRule(v,p,['rule:read'],s.key))items.push({key:s.key,workspace:s.workspace,
        policy:structuredClone(s.policy),canDraft:canRule(v,p,['rule:draft'],s.key),canReview:canRule(v,p,['rule:review'],s.key),
        sourceIds:[...new Set(grants(v,p,['rule:read']).filter(g=>g.specificationKeys.includes(s.key)&&taskRuleSourceFields.every(f=>g.sourceFields.includes(f))).flatMap(g=>g.sourceIds))].sort()});
      await fence(p,v,epoch);return items;
    },
    async authorizeRule(p,permission,k) { if (!RULE_PERMISSIONS.includes(permission) || !key(k)) return false;
      const epoch = await authority(p), v = load(), allowed = canRule(v,p,[permission],k); await fence(p,v,epoch); return allowed; },
    async rulePolicyFor(p,k) { const epoch = await authority(p), v = load(); if (!key(k) || !canRule(v,p,RULE_PERMISSIONS,k)) fail('TASK_RULE_FORBIDDEN');
      const target = v.rules.specifications.find(s => s.key === k); if (!target) fail('TASK_RULE_FORBIDDEN'); await fence(p,v,epoch); return structuredClone(target.policy); },
    async qualifySource(p,{source,binding,compiled}) {
      const epoch = await authority(p), v = load(), now = clock();
      if (!Number.isFinite(now)) fail('TASK_RULE_CONFIGURATION_INVALID');
      const targets = v.rules.specifications.filter(s => s.workspace === source.workspaceKey && s.policy.definitionKeys.includes(compiled.definition.key)
        && s.policy.scopeKeys.includes(compiled.definition.scope.key) && s.policy.bindings.some(b => digest(b) === digest(binding)));
      const target = targets.length === 1 ? targets[0] : undefined;
      const allowed = !!target && source._tenantId === tenantId && source._type === SOURCE_TYPE && !source._deletedAt && source.lifecycle === 'ACTIVE' && source.deterministic === true
        && taskRuleSourceFields.filter(f => !['deterministic','effectiveFrom'].includes(f)).every(f => typeof source[f] === 'string' && source[f].trim().length > 0)
        && typeof source.effectiveFrom === 'string' && Number.isFinite(Date.parse(source.effectiveFrom)) && Date.parse(source.effectiveFrom) <= now
        && grants(v,p,RULE_PERMISSIONS).some(g => g.specificationKeys.includes(target.key) && g.sourceIds.includes(source._id) && taskRuleSourceFields.every(f => g.sourceFields.includes(f)));
      await fence(p,v,epoch);
      return { allowed, policyHash: digest({ semantics: sourceSemantics, purpose: target ? { key: target.key, workspace: target.workspace, policy: target.policy,
        classification: v.classifications[target.workspace] } : null }) };
    },
    async authorizeResult(p,permission,k,episodeId) { if (!RESULT_PERMISSIONS.includes(permission) || !key(k) || !id(episodeId)) return false;
      const epoch = await authority(p), v = load(), target = v.rules.evaluations.find(e => e.key === k && e.episodeIds.includes(episodeId));
      const allowed = !!target && canResult(v,p,[permission],k) && await episodeScope(v,target,episodeId); await fence(p,v,epoch); return allowed; },
    async resultPolicyFor(p,k,episodeId) { const epoch = await authority(p), v = load(), target = v.rules.evaluations.find(e => e.key === k && e.episodeIds.includes(episodeId));
      if (!target || !canResult(v,p,RESULT_PERMISSIONS,k) || !await episodeScope(v,target,episodeId)) fail('TASK_RULE_FORBIDDEN'); await fence(p,v,epoch); return structuredClone(target.policy); },
    async qualifyApplication(p,{specification,targetTime}) {
      const epoch = await authority(p), v = load(), point = Date.parse(targetTime); let allowed = Number.isFinite(point);
      for (const rule of specification.rules) {
        const source = await storage.getObject(ctx,SOURCE_TYPE,rule.ruleRevision.id);
        if (!source || source._tenantId !== tenantId || source._deletedAt || digest(source) !== rule.ruleRevision.hash || source._version !== rule.ruleRevision.version
          || !Number.isFinite(Date.parse(source.effectiveFrom)) || Date.parse(source.effectiveFrom) > point) allowed = false;
      }
      await fence(p,v,epoch); return { allowed,policyHash:digest(sourceSemantics) };
    },
  };
}

export function createPrivateTaskRuleServices(options) {
  const { storage,tenantId,definitions,episodes,cel,clock } = options;
  if (typeof definitions?.requirePublished !== 'function' || typeof episodes?.readCurrentTemporalInput !== 'function' || typeof cel?.evaluate !== 'function') fail('TASK_RULE_DEPENDENCY_CONFIGURATION_REQUIRED');
  const access = createPrivateTaskRuleAccess(options), timing = clock ? { clock } : {};
  const ruleSpecifications = new NativeRuleRegistry({ storage,tenantId,definitions,...timing,authorize:access.authorizeRule,authorizationRevision:access.authorizationRevision,
    policyFor:access.rulePolicyFor,qualifySource:access.qualifySource,validateSpecification:async(compiled,specification) => { createRuleBackend(compiled,specification); } });
  const ruleResults = new NativeRuleRuntime({ storage,tenantId,rules:ruleSpecifications,episodes,...timing,authorize:access.authorizeResult,authorizationRevision:access.authorizationRevision,
    policyFor:access.resultPolicyFor,qualifyApplication:access.qualifyApplication,evaluator:{id:'typed-cel-rule-v1',evaluate:async(compiled,specification,input) => createRuleBackend(compiled,specification).evaluate(input,{evaluateCel:(...a) => cel.evaluate(...a)})} });
  const ruleWorkbench=options.catalog?createPrivateRuleWorkbench({...options,access,ruleSpecifications,sourceFields:taskRuleSourceFields}):undefined;
  return { ruleSpecifications,ruleResults,...(ruleWorkbench?{ruleWorkbench}:{}),assertConfigured:access.assertConfigured };
}

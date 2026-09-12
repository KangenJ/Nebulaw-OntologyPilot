import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { NativeScenarioRuntime,validateAdaptiveScenarioAssumptions } from '../../platform/packages/plus-runtime/dist/index.js';
import { createPublishedVerificationPlanner } from '../../services/plus-engine/verification-planning.mjs';
import { createCompositionVerificationPlanner } from '../../services/plus-engine/composition-verification-planning.mjs';
import { createLearnedCompositionVerificationPlanner } from '../../services/plus-engine/learned-composition-verification-planning.mjs';
import { createIsolatedLearnedAdaptiveVerificationPlanner } from '../../services/plus-engine/learned-adaptive-verification-process.mjs';
import { createPrivateAuthorizationRevision } from './private-authority.mjs';
import { createPrivateScenarioWorkbench } from './scenario-workbench-services.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const fields=(v,n)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===n.length&&n.every(k=>Object.hasOwn(v,k));
const key=v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(v);
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const list=(v,check,max)=>Array.isArray(v)&&v.length>0&&v.length<=max&&v.every(check)&&new Set(v).size===v.length;
const permissions=['scenario:compare','scenario:read'];
export function createPrivateScenarioAccess(options){
  const {loadPolicy}=options,authority=createPrivateAuthorizationRevision(options);
  function load(){const v=structuredClone(loadPolicy()?.scenarioPlanning);
    if(!fields(v,['version','enabled','targets','grants'])||v.version!=='plus-private-scenario-planning-v1'||typeof v.enabled!=='boolean'
      ||!Array.isArray(v.targets)||v.targets.length>100||!Array.isArray(v.grants)||v.grants.length>500)fail('SCENARIO_CONFIGURATION_INVALID');
    const keys=new Set();for(const target of v.targets){
      if(!fields(target,['key','episodeIds','policy'])||!key(target.key)||keys.has(target.key)||!list(target.episodeIds,id,1000))fail('SCENARIO_CONFIGURATION_INVALID');keys.add(target.key);
      const p=target.policy,adaptive=p?.version==='plus-verification-scenario-policy-v2';
      if(!fields(p,['version','id','definitionKeys','scopeKeys','classifications',...(adaptive?['adaptiveAssumptions']:[])])||(!adaptive&&p.version!=='plus-verification-scenario-policy-v1')||!key(p.id)
        ||!list(p.definitionKeys,key,100)||!list(p.scopeKeys,key,100)||!list(p.classifications,c=>['SYNTHETIC','AUTHORIZED_REAL'].includes(c),2))fail('SCENARIO_CONFIGURATION_INVALID');
      if(adaptive)validateAdaptiveScenarioAssumptions(p.adaptiveAssumptions);
    }
    for(const g of v.grants){if(!fields(g,['principalId','requiredRoles','permissions','targets'])||!id(g.principalId)||!list(g.requiredRoles,key,32)||!list(g.permissions,p=>permissions.includes(p),2)
      ||!Array.isArray(g.targets)||!g.targets.length||g.targets.length>100||new Set(g.targets.map(t=>t.key)).size!==g.targets.length)fail('SCENARIO_CONFIGURATION_INVALID');
      for(const t of g.targets){const declared=v.targets.find(d=>d.key===t.key);if(!fields(t,['key','episodeIds'])||!key(t.key)||!list(t.episodeIds,id,1000)||!declared||t.episodeIds.some(e=>!declared.episodeIds.includes(e)))fail('SCENARIO_CONFIGURATION_INVALID');}
    }
    return v;
  }
  const grant=(v,p,allowed,k,e)=>v.enabled&&v.grants.some(g=>g.principalId===p.id&&g.requiredRoles.every(r=>p.roles.includes(r))&&g.permissions.some(r=>allowed.includes(r))&&g.targets.some(t=>t.key===k&&t.episodeIds.includes(e)));
  async function fence(p,v,epoch){if(await authority(p)!==epoch||digest(load())!==digest(v))fail('SCENARIO_AUTHORITY_STALE');}
  return {authorizationRevision:authority,assertConfigured:()=>{load();},
    async authorize(p,permission,k,e){if(!permissions.includes(permission)||!key(k)||!id(e))return false;const epoch=await authority(p),v=load(),allowed=grant(v,p,[permission],k,e);await fence(p,v,epoch);return allowed;},
    async listTargets(p){const epoch=await authority(p),v=load(),items=[];
      for(const target of v.targets)for(const episodeId of target.episodeIds){if(grant(v,p,['scenario:read'],target.key,episodeId))items.push({key:target.key,episodeId,mayCompare:grant(v,p,['scenario:compare'],target.key,episodeId)});}
      if(items.length>1000)fail('SCENARIO_COLLECTION_LIMIT');await fence(p,v,epoch);return items;
    },
    async policyFor(p,k,e){const epoch=await authority(p),v=load();if(!key(k)||!id(e)||!grant(v,p,permissions,k,e))fail('SCENARIO_FORBIDDEN');const target=v.targets.find(t=>t.key===k&&t.episodeIds.includes(e));if(!target)fail('SCENARIO_FORBIDDEN');await fence(p,v,epoch);return structuredClone(target.policy);},
  };
}
export function createPrivateScenarioServices(options){
  const {storage,tenantId,beliefs,definitions,recipes,compute}=options;
  if(typeof beliefs?.readCurrent!=='function'||typeof definitions?.requirePublished!=='function'||typeof recipes?.requireApproved!=='function'||typeof compute?.readFitForEvaluation!=='function')fail('SCENARIO_CONFIGURATION_INVALID');
  const access=createPrivateScenarioAccess(options);
  const complete=options.loadPolicy().learnedCompositionReplay?.enabled===true;
  if(complete&&typeof compute.readLearnedCompositionFitForEvaluation!=='function')fail('SCENARIO_COMPLETE_CONFIGURATION_INVALID');
  const scenarios=new NativeScenarioRuntime({storage,tenantId,beliefs,definitions,recipes,compute,authorize:access.authorize,policyFor:access.policyFor,authorizationRevision:access.authorizationRevision,readQualificationPhase:options.readQualificationPhase,
    planner:createPublishedVerificationPlanner(),...(options.loadPolicy().compositionReplay?.enabled===true?{compositionPlanner:createCompositionVerificationPlanner()}: {}),
    ...(complete?{learnedCompositionPlanner:createLearnedCompositionVerificationPlanner(),adaptivePlanner:createIsolatedLearnedAdaptiveVerificationPlanner()}: {})});
  return {scenarios,...(options.catalog&&typeof beliefs.readHeadMetadata==='function'?{scenarioWorkbench:createPrivateScenarioWorkbench({...options,scenarios,access})}:{}),assertConfigured:access.assertConfigured};
}

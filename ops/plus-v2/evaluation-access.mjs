import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { createPrivateAuthorizationRevision } from './private-authority.mjs';
import { learnedCompositionStateEvaluatorId } from '../../platform/packages/plus-runtime/dist/index.js';
import { validateNativeRecipeSelection } from './native-recipe-selection.mjs';

const PERMISSIONS=['evaluation:draft','evaluation:review','evaluation:read','evaluation:use','evaluation:revoke','evaluation:run','evaluation:result-read'];
const fail=code=>{throw Object.assign(new Error(code),{code});};
const key=v=>typeof v==='string'&&v.length>0&&v.length<=256&&v.trim()===v&&!/[\x00-\x1f\x7f]/.test(v);
const fields=(v,n)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===n.length&&n.every(k=>Object.hasOwn(v,k));
const list=(v,max=100)=>Array.isArray(v)&&v.length>0&&v.length<=max&&v.every(key)&&new Set(v).size===v.length;

/** Protocol-specific private G1 grants. A purpose pins exact recipe hashes and
 * supported evaluators; underlying native data/recipe providers enforce their
 * own object/field/workspace permissions. No caller-supplied policy is accepted.
 */
export function createPrivateEvaluationAccess({tenantId,identities,loadPolicy,reauthenticate,evaluatorIds,recipeSelections}){
  if(!list(evaluatorIds,10))fail('EVALUATION_PRIVATE_CONFIGURATION_INVALID');
  const authorizationRevision=createPrivateAuthorizationRevision({tenantId,identities,loadPolicy,reauthenticate});
  function load(){
    const raw=loadPolicy()?.evaluation;if(raw===undefined)return null;
    const v=structuredClone(raw);
    if(!fields(v,['version','enabled','protocols','grants'])||!['plus-private-evaluation-v1','plus-private-evaluation-v2'].includes(v.version)||typeof v.enabled!=='boolean'
      ||!Array.isArray(v.protocols)||v.protocols.length>100||!Array.isArray(v.grants)||v.grants.length>500)fail('EVALUATION_PRIVATE_CONFIGURATION_INVALID');
    const keys=new Set();
    for(const e of v.protocols){
      const p=e?.purpose;
      const selected=Object.hasOwn(p??{},'recipeSelections');
      if(!fields(e,['key','purpose'])||!key(e.key)||keys.has(e.key)||!fields(p,['version','id','evaluatorIds',selected?'recipeSelections':'recipeHashes','classifications',...(Object.hasOwn(p??{},'reference')?['reference']:[])])
        ||p.version!=='plus-evaluation-purpose-v1'||!key(p.id)||!list(p.evaluatorIds,10)||p.evaluatorIds.some(id=>!evaluatorIds.includes(id))
        ||!selected&&(!list(p.recipeHashes)||p.recipeHashes.some(h=>!/^[a-f0-9]{64}$/.test(h)))||!list(p.classifications,2)||p.classifications.some(c=>!['SYNTHETIC','AUTHORIZED_REAL'].includes(c)))fail('EVALUATION_PRIVATE_CONFIGURATION_INVALID');
      if(selected){if(v.version!=='plus-private-evaluation-v2'||typeof recipeSelections?.resolve!=='function'||!Array.isArray(p.recipeSelections)
        ||!p.recipeSelections.length||p.recipeSelections.length>10||new Set(p.recipeSelections.map(digest)).size!==p.recipeSelections.length)fail('EVALUATION_PRIVATE_CONFIGURATION_INVALID');
        for(const raw of p.recipeSelections){const selection=validateNativeRecipeSelection(raw);if(!p.classifications.includes(selection.classification))fail('EVALUATION_PRIVATE_CONFIGURATION_INVALID');}}
      keys.add(e.key);
      if(p.reference!==undefined&&(!fields(p.reference,['mode','controlKey'])||!['CURRENT_PUBLICATION','COLD_START'].includes(p.reference.mode)||!key(p.reference.controlKey)
        ||p.reference.mode==='COLD_START'&&(p.evaluatorIds.length!==1||p.evaluatorIds[0]!==learnedCompositionStateEvaluatorId)))fail('EVALUATION_PRIVATE_CONFIGURATION_INVALID');
    }
    for(const g of v.grants)if(!fields(g,['principalId','requiredRoles','protocolKeys','permissions'])||!key(g.principalId)||!list(g.requiredRoles,32)
      ||!list(g.protocolKeys)||g.protocolKeys.some(k=>!keys.has(k))||!list(g.permissions,PERMISSIONS.length)||g.permissions.some(p=>!PERMISSIONS.includes(p)))fail('EVALUATION_PRIVATE_CONFIGURATION_INVALID');
    return v;
  }
  const granted=(v,p,permissions,k)=>v?.enabled&&v.grants.some(g=>g.principalId===p.id&&g.requiredRoles.every(r=>p.roles.includes(r))
    &&g.protocolKeys.includes(k)&&permissions.some(q=>g.permissions.includes(q)));
  async function fence(p,revision,v){if(await authorizationRevision(p)!==revision||digest(load())!==digest(v))fail('EVALUATION_PRIVATE_AUTHORITY_STALE');}
  return {
    authorizationRevision,
    assertConfigured(){load();},
    async resultKeys(principal){
      const p=structuredClone(principal),revision=await authorizationRevision(p),v=load();
      // Discovery does not resolve dynamic recipe selections or qualify models.
      const keys=(v?.protocols??[]).filter(e=>granted(v,p,['evaluation:result-read'],e.key)).map(e=>e.key).sort();
      await fence(p,revision,v);return keys;
    },
    async authorize(p,permission,k){
      if(!PERMISSIONS.includes(permission)||!key(k))return false;
      const revision=await authorizationRevision(p),v=load(),allowed=!!granted(v,p,[permission],k);
      await fence(p,revision,v);return allowed;
    },
    async policyFor(p,k){
      const revision=await authorizationRevision(p),v=load();
      if(!key(k)||!granted(v,p,PERMISSIONS,k))fail('EVALUATION_FORBIDDEN');
      const entry=v.protocols.find(e=>e.key===k);if(!entry)fail('EVALUATION_FORBIDDEN');
      let purpose=entry.purpose;
      if(purpose.recipeSelections){const {recipeSelections:selections,...fixed}=purpose,recipeHashes=[];
        for(const selection of selections){const resolved=await recipeSelections.resolve(selection,p);
          if(typeof resolved?.recipeHash!=='string'||!/^[a-f0-9]{64}$/.test(resolved.recipeHash))fail('EVALUATION_RECIPE_SELECTION_INVALID');recipeHashes.push(resolved.recipeHash);}
        if(new Set(recipeHashes).size!==recipeHashes.length)fail('EVALUATION_RECIPE_SELECTION_INVALID');purpose={...fixed,recipeHashes};}
      await fence(p,revision,v);return structuredClone(purpose);
    },
  };
}

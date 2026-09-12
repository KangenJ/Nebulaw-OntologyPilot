import {digest} from '../../platform/packages/plus-contracts/dist/index.js';
import {createPrivateObjectReader} from './object-read-services.mjs';
const fail=code=>{throw Object.assign(Error(code),{code});};
const key=v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(v);
const clean=v=>JSON.parse(JSON.stringify(v));

// Discovery of already configured purposes, not permission installation. Source
// content requires BOTH private rule-source qualification and native field read.
export function createPrivateRuleWorkbench(options){
  const {storage,tenantId,definitions,access,ruleSpecifications,sourceFields}=options;
  const reader=createPrivateObjectReader(options);
  async function start(principal){
    const p=structuredClone(principal);if(p?.tenantId!==tenantId)fail('TASK_RULE_FORBIDDEN');
    const authority=await access.authorizationRevision(p),ctx={tenantId,actorId:p.id},epoch=await storage.getReadRevision(ctx);
    return {p,ctx,authority,epoch};
  }
  async function finish(s){if(await access.authorizationRevision(s.p)!==s.authority)fail('TASK_RULE_AUTHORITY_STALE');
    if(await storage.getReadRevision(s.ctx)!==s.epoch)fail('CONFLICT');}
  const flags={readOnly:true,predictionReady:false,executionAuthorized:false};
  return {
    async read(principal){const s=await start(principal),purposes=await access.workbenchPurposes(s.p);
      const items=purposes.map(p=>({key:p.key,definitionKeys:p.policy.definitionKeys,canDraft:p.canDraft,canReview:p.canReview}));
      await finish(s);return {schema:'plus-rule-workbench-index-v1',items,...flags};
    },
    async options(input,principal){
      if(!input||Object.keys(input).sort().join(',')!=='definitionKey,key'||!key(input.key)||!key(input.definitionKey))fail('TASK_RULE_INVALID_INPUT');
      const s=await start(principal),purposes=await access.workbenchPurposes(s.p),purpose=purposes.find(v=>v.key===input.key);
      if(!purpose||!purpose.policy.definitionKeys.includes(input.definitionKey))fail('TASK_RULE_FORBIDDEN');
      const published=await definitions.requirePublished(input.definitionKey,s.p),compiled=published.compiled;
      if(!purpose.policy.scopeKeys.includes(compiled.definition.scope.key))fail('TASK_RULE_FORBIDDEN');
      const modules=compiled.definition.modules.filter(m=>m.kind==='RULE');
      if(!modules.length||modules.length!==purpose.policy.bindings.length||modules.some(m=>!purpose.policy.bindings.some(b=>b.moduleKey===m.key)))fail('TASK_RULE_BINDING_INVALID');
      if(purpose.sourceIds.length>100)fail('TASK_RULE_COLLECTION_LIMIT');
      const sources=[];
      for(const sourceId of purpose.sourceIds){
        const raw=await storage.getObject(s.ctx,'RuleVersion',sourceId);if(!raw||raw._deletedAt)continue;
        const moduleKeys=[];
        for(const binding of purpose.policy.bindings)if((await access.qualifySource(s.p,{source:raw,binding,compiled})).allowed)moduleKeys.push(binding.moduleKey);
        if(!moduleKeys.length)continue;
        const view=await reader.read('RuleVersion',sourceId,s.p);
        if(view.reference.version!==raw._version||sourceFields.some(f=>!Object.hasOwn(view.object,f)||digest(view.object[f])!==digest(raw[f])))fail('TASK_RULE_SOURCE_FIELDS_REQUIRED');
        sources.push({reference:{id:raw._id,version:raw._version,hash:digest(raw)},moduleKeys,fields:Object.fromEntries(sourceFields.map(f=>[f,structuredClone(raw[f])]))});
      }
      const variables=compiled.variables.filter(v=>modules.some(m=>m.inputs.includes(v.key)||m.outputs.includes(v.key))).map(v=>clean({key:v.key,role:v.role,valueType:v.valueType,unit:v.unit,support:v.support,unknownValues:v.unknownValues,source:v.source,sourceType:v.sourceType,referenceType:v.referenceType}));
      const revisions=await ruleSpecifications.listRevisions(purpose.key,s.p);
      const response={schema:'plus-rule-authoring-options-v1',key:purpose.key,definitionKey:input.definitionKey,definitionHash:compiled.definitionHash,
        definitionReference:{id:published.record._id,version:published.record._version,compiledHash:digest(compiled)},
        modules:structuredClone(modules),variables,sources,revisions,canDraft:purpose.canDraft,canReview:purpose.canReview,...flags};
      if(Buffer.byteLength(JSON.stringify(response))>1048576)fail('TASK_RULE_COLLECTION_LIMIT');
      await finish(s);return response;
    },
  };
}

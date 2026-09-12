import { canonicalJson,digest } from '@openfoundry/plus-contracts';

function fail():never { throw Object.assign(new Error('ACTION_INTERVAL_DEPENDENCY_CONTRACT'),{code:'ACTION_INTERVAL_DEPENDENCY_CONTRACT'}); }
const object=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))fail();return v as Record<string,unknown>;};
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const same=(a:unknown,b:unknown)=>canonicalJson(a)===canonicalJson(b);
const exact=(v:Record<string,unknown>,names:string[])=>same(Object.keys(v).sort(),[...names].sort());
const signed=(v:Record<string,unknown>)=>{const {contentHash,...body}=v;if(!hash(contentHash)||contentHash!==digest(body))fail();};
const reference=(raw:unknown)=>{const r=object(raw);if(!exact(r,['type','id','version','hash'])||typeof r.type!=='string'||!r.type||typeof r.id!=='string'||!r.id
  ||!Number.isSafeInteger(r.version)||Number(r.version)<1||!hash(r.hash))fail();return r;};

/** Pure versioned dependency projection, NOT native authority. Consumers must
 * compare the original exposure with a FRESH full native read under current
 * policy/identity/epoch. Never accept a client's self-hashed certificate.
 * v1 preserves the exact former conservative projection. v2 is possible only
 * when the approved policy itself binds the new semantics and proof is present.
 * v3 removes only the historical authority snapshot from the semantic evidence,
 * AFTER checking its consistency. The original exposure is never rewritten. */
export function actionIntervalDependencies(raw:unknown):Record<string,unknown> {
  const m=object(raw);if(Buffer.byteLength(canonicalJson(m))>8*1024*1024)fail();signed(m);
  const r=object(m.readSet),p=object(m.policy);
  if(m.schema!=='plus-native-action-interval-v1'||m.actionIntervalAuthorityChecked!==true||m.coverage!=='COMPLETE_GOVERNED_NATIVE_ACTION_INTERVAL'
    ||!hash(r.authorizationRevision)||typeof r.nativeEpoch!=='string'||!r.nativeEpoch||!hash(r.inventoryHash)||!hash(r.fitInventoryHash)
    ||r.fitInventorySchema!=='plus-governed-fit-inventory-v1'||!hash(r.ontologyHash)||m.policyHash!==digest(p))fail();
  const {contentHash,knowledgeCutoff,readSet,...facts}=m;
  if(p.version==='plus-native-action-interval-policy-v1'){
    const {nativeEpoch,inventoryHash,...stable}=r;return {...facts,readSet:stable};
  }
  if(!['plus-native-action-interval-policy-v2','plus-native-action-interval-policy-v3'].includes(String(p.version)))fail();
  if(!exact(r,['nativeEpoch','authorizationRevision','ontologyHash','inventoryHash','fitInventorySchema','fitInventoryHash','references','intervalEvidence']))fail();
  const e=object(r.intervalEvidence);signed(e);
  if(!exact(e,['schema','tenantId','root','episodeId','definitionHash','bindingHash','startedAt','fromTime','toTime','policyHash','authorizationRevision','ontologyHash','rootReferences','executions','semantics','contentHash'])
    ||e.schema!=='plus-root-interval-action-evidence-v1'||e.semantics!=='FULL_INVENTORY_REQUALIFIED_ROOT_INTERVAL_EXECUTIONS_ONLY'
    ||!['tenantId','root','episodeId','definitionHash','bindingHash','startedAt','fromTime','toTime','policyHash','executions'].every(k=>same(e[k],m[k]))
    ||e.authorizationRevision!==r.authorizationRevision||e.ontologyHash!==r.ontologyHash||!Array.isArray(e.rootReferences)||e.rootReferences.length!==3
    ||!Array.isArray(r.references)||!Array.isArray(e.executions))fail();
  const refs=e.rootReferences.map(reference),inventory=r.references.map(reference),root=object(m.root);
  if(new Set(refs.map(v=>v.id)).size!==3||refs.some(v=>!inventory.some(i=>same(i,v)))
    ||refs.filter(v=>same(v,m.episode)).length!==1||refs.filter(v=>v.type===root.type&&v.id===root.id).length!==1
    ||refs.filter(v=>v.type===p.rootEpisodeLink).length!==1)fail();
  for(const execution of e.executions){const x=object(execution);const journals=x.journals;
    if(!Array.isArray(journals)||journals.length!==2)fail();
    for(const value of [x.request,x.decision,x.nativeReceipt,...journals]){const ref=reference(value);if(!inventory.some(i=>same(i,ref)))fail();}
  }
  if(p.version==='plus-native-action-interval-policy-v3'){
    // Exact named projection, not a recursive hash removal or an authority
    // certificate. policyHash, ontology and every root/execution reference stay.
    const {contentHash:evidenceHash,authorizationRevision,...semanticEvidence}=e;
    return {...facts,readSet:{schema:'plus-requalified-action-dependencies-v1',ontologyHash:r.ontologyHash,
      intervalEvidence:semanticEvidence}};
  }
  return {...facts,readSet:{authorizationRevision:r.authorizationRevision,ontologyHash:r.ontologyHash,intervalEvidence:e}};
}

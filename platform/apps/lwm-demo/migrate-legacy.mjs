import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
const source=resolve(process.env.LWM_LEGACY_SNAPSHOT??'var/lwm/legacy-demo-snapshot-2026-09-05.json');
const raw=readFileSync(source,'utf8'),hash=createHash('sha256').update(raw).digest('hex');
const saved=JSON.parse(raw),legacy=saved.data??saved;
if(!Array.isArray(legacy.matters)||!Array.isArray(legacy.observations))throw new Error('Expected archived legacy snapshot');
const rows=legacy.matters.map(m=>({legacyId:m.id,matterNumber:m.matterNumber,title:m.title,jurisdiction:m.jurisdiction,currentState:m.currentState,source:'legacy-sha256:'+hash+'/'+m.id,evidence:m.summary??m.title,
  observations:legacy.observations.filter(o=>m.observationIds?.includes(o.id)).map(o=>({summary:o.summary,source:'legacy:'+o.id+' / '+o.source}))}));
const report={checkedAt:new Date().toISOString(),sourceHash:hash,matters:rows.length,observations:rows.reduce((n,r)=>n+r.observations.length,0),retained:'Original snapshot remains unchanged and recoverable',held:'Evidence requires fresh verification; unsafe historical actions/model scores not restored',mode:process.argv.includes('--apply')?'apply':'dry-run'};
if(process.argv.includes('--apply')){
  const credentials=JSON.parse(readFileSync(process.env.LWM_ACCESS_FILE??'var/lwm/plus-access/local-access.json'));
  const identity=credentials.credentials.find(c=>c.role==='investigator');
  const endpoint=process.env.LWM_PLUS_URL??'http://127.0.0.1:4183';
  const url=new URL(endpoint);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('Local migration tool only sends credentials to loopback');
  const response=await fetch(endpoint+'/api/plus/migrateLegacy',{method:'POST',headers:{authorization:'Bearer '+identity.token,'content-type':'application/json','idempotency-key':'migration-'+hash},body:JSON.stringify({rows,mapping:{},source:'legacy-sha256:'+hash})});
  const result=await response.json();if(!response.ok)throw new Error(JSON.stringify(result));
  const state=await(await fetch(endpoint+'/api/state',{headers:{authorization:'Bearer '+identity.token}})).json();
  report.mapping=rows.map(row=>({legacyId:row.legacyId,nativeId:state.data.objects.Matter.items.find(m=>m.matterNumber===row.matterNumber)?._id,matterNumber:row.matterNumber}));
  if(report.mapping.some(row=>!row.nativeId))throw new Error('Migration reconciliation failed');
  report.receipt=result.data.receipt;report.reconciled=true;
}
const output=process.argv.find(a=>a.startsWith('--output='));
if(output)writeFileSync(resolve(output.slice(9)),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));

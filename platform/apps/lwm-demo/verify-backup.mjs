// Restore a consistent backup into a new isolated directory and independent
// ports. Never replaces the user's source database or its running services.
import {DatabaseSync} from 'node:sqlite';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {startPlusHarness} from './tests/plus-harness.mjs';
if(!process.argv[2]||process.argv[2].startsWith('--'))throw new Error('Supply an existing consistent native backup');
const snapshotPath=resolve(process.argv[2]),db=new DatabaseSync(snapshotPath,{readOnly:true});
let saved,audits;
try{assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');saved=JSON.parse(db.prepare('SELECT payload FROM lwm_state WHERE id=1').get().payload);audits=db.prepare('SELECT record FROM native_audit ORDER BY rowid DESC').all().map(r=>JSON.parse(r.record));}finally{db.close();}
const h=await startPlusHarness(undefined,{snapshotPath});
try{
  const recovered=await h.good('/state'),expected=saved.native.objects.map(([,o])=>o).filter(o=>!o._deletedAt&&o._tenantId==='lwm-demo');
  const actual=Object.values(recovered.objects).flatMap(page=>page.items),byId=(a,b)=>a._id.localeCompare(b._id);
  assert.deepEqual(actual.sort(byId),expected.sort(byId));assert.deepEqual(recovered.audit,audits);
  const report={checkedAt:new Date().toISOString(),passed:true,restoredTo:'isolated temporary native database and independent service ports',sourceUntouched:true,objects:actual.length,auditRecords:audits.length,compared:'Every current native object property/version and complete audit records',cloudRecoveryVerified:false};
  const output=process.argv.find(a=>a.startsWith('--output='));if(output)writeFileSync(output.slice(9),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await h.close();}

// Synthetic storage-cost diagnostic, not a business/model performance acceptance.
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { createNativeStorage } from '../../platform/apps/lwm-demo/src/native-storage.mjs';

const dir=mkdtempSync(join(tmpdir(),'plus-native-epoch-bench-')),path=join(dir,'native.sqlite'),storage=createNativeStorage(path),ctx={tenantId:'synthetic-epoch-benchmark'};
let direct;
try{
  await storage.applySchema(ctx,{version:1,objectTypes:[{name:'SyntheticPayload',properties:[{name:'payload',type:'String',required:true}]}],linkTypes:[]});
  await storage.createObject(ctx,'SyntheticPayload',{payload:'SYNTHETIC_ONLY_'.repeat(100000)});
  direct=new DatabaseSync(path);
  const sql=direct.prepare('SELECT payload FROM lwm_state WHERE id=1'),bytes=Buffer.byteLength(sql.get().payload),iterations=200;
  const previous=()=>String(JSON.parse(sql.get().payload).revision);
  const oldEpoch=previous(),newEpoch=await storage.getReadRevision(ctx);if(oldEpoch!==newEpoch)throw new Error('EPOCH_MISMATCH');
  const time=async run=>{const start=performance.now();for(let i=0;i<iterations;i++)if(await run()!==oldEpoch)throw new Error('EPOCH_CHANGED');return performance.now()-start;};
  const serialized=sql.get().payload,exactPayload=()=>{if(sql.get().payload!==serialized)throw new Error('PAYLOAD_CHANGED');return oldEpoch;};
  const previousMs=await time(previous),exactPayloadCacheMs=await time(exactPayload),sqliteInvalidationCacheMs=await time(()=>storage.getReadRevision(ctx));
  console.log(JSON.stringify({schema:'plus-native-epoch-benchmark-v2',classification:'SYNTHETIC',payloadBytes:bytes,iterations,previousMs,exactPayloadCacheMs,sqliteInvalidationCacheMs,
    ratioAgainstExactPayload:exactPayloadCacheMs/sqliteInvalidationCacheMs,scope:'Same SQLite payload/epoch. Full parse, full payload comparison, and per-read SQLite data-version invalidation. No authorization cache or model latency claim.'},null,2));
}finally{direct?.close();storage.close();rmSync(dir,{recursive:true,force:true});}

import { basename,dirname } from 'node:path';
import { createNativeStorage } from '../../../apps/lwm-demo/src/native-storage.mjs';
import { NativeOntologyCatalog } from '../dist/index.js';
const path=process.argv[2];
if(!path||!basename(dirname(path)).startsWith('plus-catalog-test-'))throw new Error('isolated catalog test database required');
const storage=createNativeStorage(path),ctx={tenantId:'catalog-test'};
try{
  const catalog=new NativeOntologyCatalog({storage,tenantId:ctx.tenantId,authorize:async(_p,permission)=>permission==='ontology:read'});
  const before=await storage.getReadRevision(ctx);
  const result=await catalog.read({id:'fresh-reader',tenantId:ctx.tenantId,roles:['viewer']});
  if(await storage.getReadRevision(ctx)!==before)throw new Error('read mutated native state');
  process.stdout.write(JSON.stringify({contentHash:result.bundle.contentHash,storageVersion:result.head.storageVersion,manifest:result.bundle.manifests.RegisterWork}));
}finally{storage.close();}

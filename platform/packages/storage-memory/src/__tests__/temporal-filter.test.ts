import { it,expect } from 'vitest';
import { MemoryStorageProvider } from '../memory-storage-provider.js';
const ctx={tenantId:'temporal-test'};
it('compares DateTime by instant through logical filters; rejects null, missing and mismatched types',async()=>{
  const storage=new MemoryStorageProvider();
  await storage.applySchema(ctx,{version:1,objectTypes:[{name:'Lease',properties:[{name:'until',type:'DateTime'}]}],linkTypes:[]});
  for(const until of ['2026-09-05T08:00:00+08:00','2026-09-04T23:00:00Z','2026-09-05T01:00:00Z',null,undefined,'invalid']) {
    await storage.createObject(ctx,'Lease',until===undefined?{}:{until});
  }
  const filter={and:[{field:'until',operator:'lte' as const,value:'2026-09-05T00:00:00Z'}]};
  expect((await storage.queryObjects(ctx,'Lease',filter)).totalCount).toBe(2);
  expect((await storage.queryObjects(ctx,'Lease',{field:'until',operator:'gte',value:'2026-09-05T00:00:00Z'})).totalCount).toBe(2);
  expect((await storage.queryObjects(ctx,'Lease',{field:'until',operator:'lt',value:0})).totalCount).toBe(0);
});
it('orders strings without coercing numbers or null to strings',async()=>{
  const storage=new MemoryStorageProvider();
  await storage.applySchema(ctx,{version:1,objectTypes:[{name:'Item',properties:[{name:'name',type:'String'}]}],linkTypes:[]});
  for(const name of ['a','b','c',null,0])await storage.createObject(ctx,'Item',{name});
  expect((await storage.queryObjects(ctx,'Item',{field:'name',operator:'lt',value:'b'})).totalCount).toBe(1);
});

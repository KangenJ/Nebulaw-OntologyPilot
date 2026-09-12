import { readFileSync } from 'node:fs';
import { parseOdl } from '@openfoundry/odl';
import { ActionExecutor } from '@openfoundry/actions';
import { createNativeStorage } from '../../../apps/lwm-demo/src/native-storage.mjs';
import { createActionOutboxJournal } from '../dist/index.js';

export const metadata = parseOdl(readFileSync(new URL('../../../domain-packs/plus-core/schema/metadata.odl',import.meta.url),'utf8'));
const business = parseOdl(`
  type WorkItem @objectType { id: ID! @primary title: String! count: Int! }
  type RegisterWork @actionType { title: String! @param }
`);
export const schema = { ...metadata, objectTypes:[...metadata.objectTypes,...business.objectTypes], actionTypes:business.actionTypes };
export const spiSchema = { version:1,
  objectTypes:schema.objectTypes.map(t=>({name:t.name,properties:t.fields.filter(f=>!f.directives.some(d=>['primary','computed','link'].includes(d.kind))).map(f=>({name:f.name,type:f.type.name,required:f.type.nonNull})),
    indexes:t.fields.filter(f=>f.directives.some(d=>d.kind==='unique')).map(f=>({field:f.name,indexType:'BTREE',unique:true}))})),
  linkTypes:schema.linkTypes.map(t=>({name:t.name,fromType:t.from,toType:t.to,cardinality:t.cardinality,properties:[]})),
};
export const context={tenantId:'plus-outbox-test',traceId:'test-trace'};
export const manifest={action:'RegisterWork',version:1,reversible:false,preconditions:[],sideEffects:[],
  effects:[{type:'createObject',objectType:'WorkItem',properties:{title:'params.title',count:'0'}}]};
export async function fixture(path, overrides={}) {
  const storage=createNativeStorage(path);
  try { await storage.getSchema(context); }
  catch(error) { if(error.message!=='Schema version 0 not found') {storage.close();throw error;} await storage.applySchema(context,spiSchema); }
  const journal=createActionOutboxJournal();
  const executor=new ActionExecutor({storage,strictEffects:true,requireConsistentReadSet:true,transactionalJournal:journal,
    security:{async checkPermission(){return {allowed:true};}},cel:{async evaluate(){return {error:'No CEL required in this fixture'};}},...overrides});
  return {storage,journal,run:()=>executor.execute(manifest,{title:'new input'},
    {id:'test-investigator',type:'user',roles:['investigator']},{requestContext:context},schema)};
}

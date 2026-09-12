import { AsyncLocalStorage } from 'node:async_hooks';
import { canonicalJson,digest } from '@openfoundry/plus-contracts';
import type { StorageProvider } from '@openfoundry/spi';
import type { PlusPrincipal } from './ontology-catalog.js';

export interface NativeReadQualificationPhase {
  run<T>(principal:PlusPrincipal,read:()=>Promise<T>):Promise<T>;
}
interface Config {
  storage:StorageProvider;tenantId:string;readers:object[];
  /** Complete same-graph external authority, including current identity expiry. */
  authorizationRevision:(p:PlusPrincipal)=>Promise<string>;clock?:()=>number;
}
interface RetainedRead {reader:object;key:string;bytes:number}
interface Phase {
  owner:object;storage:StorageProvider;active:boolean;readers:Set<object>;
  fence:(p:PlusPrincipal)=>Promise<void>;principals:Map<string,PlusPrincipal>;
  results:Map<object,Map<string,unknown>>;entries:number;bytes:number;
  retained:Map<object,Map<string,RetainedRead>>;
  recency:Map<RetainedRead,true>;
}
const current=new AsyncLocalStorage<Phase>();
const principalKey=(p:PlusPrincipal)=>digest({id:p.id,tenantId:p.tenantId,roles:[...p.roles].sort()});
function fail(code:string):never{throw Object.assign(new Error(code),{code});}

/** Trusted composition root only. No serialized handle, runtime flag or global
 * cache. A phase must contain reads only, and must end BEFORE externally visible
 * output or transaction commit. Every distinct actor is reauthenticated at the
 * final fence; checking only the HTTP actor would miss original trainer expiry.
 */
export function createNativeReadQualificationPhase(config:Config):NativeReadQualificationPhase {
  if(!config.storage?.getReadRevision||typeof config.authorizationRevision!=='function'||!config.tenantId
    ||!Array.isArray(config.readers)||config.readers.length>128||config.readers.some(r=>!r||typeof r!=='object'))fail('NATIVE_QUALIFICATION_CONFIGURATION');
  const owner=Object.freeze({}),readers=new Set(config.readers),clock=config.clock??Date.now;
  return {async run<T>(principal:PlusPrincipal,read:()=>Promise<T>):Promise<T>{
    const p=structuredClone(principal),inherited=current.getStore();
    if(inherited?.owner===owner){
      if(!inherited.active)fail('NATIVE_QUALIFICATION_CLOSED');
      await inherited.fence(p);const result=await read();await inherited.fence(p);return result;
    }
    const ctx={tenantId:config.tenantId,actorId:p?.id};
    let lastTime=clock();if(!Number.isFinite(lastTime))fail('NATIVE_QUALIFICATION_CLOCK');
    const revision=await config.authorizationRevision(p),epoch=await config.storage.getReadRevision!(ctx);
    if(typeof revision!=='string'||!/^[a-f0-9]{64}$/.test(revision))fail('NATIVE_QUALIFICATION_AUTHORITY');
    const state:Phase={owner,storage:config.storage,active:true,readers,principals:new Map(),results:new Map(),retained:new Map(),recency:new Map(),entries:0,bytes:0,
      fence:async actor=>{
        if(!state.active)fail('NATIVE_QUALIFICATION_CLOSED');
        if(!actor?.id||actor.tenantId!==config.tenantId||!Array.isArray(actor.roles))fail('NATIVE_QUALIFICATION_PRINCIPAL');
        const before=clock();if(!Number.isFinite(before)||before<lastTime)fail('NATIVE_QUALIFICATION_CLOCK');lastTime=before;
        if(await config.authorizationRevision(actor)!==revision)fail('NATIVE_QUALIFICATION_AUTHORITY_STALE');
        if(await config.storage.getReadRevision!({tenantId:actor.tenantId,actorId:actor.id})!==epoch)fail('NATIVE_QUALIFICATION_CONFLICT');
        const after=clock();if(!Number.isFinite(after)||after<lastTime)fail('NATIVE_QUALIFICATION_CLOCK');lastTime=after;
        state.principals.set(principalKey(actor),structuredClone(actor));
      }};
    try{return await current.run(state,async()=>{
      await state.fence(p);const result=await read();
      // Snapshot the actors: fence itself records an actor but cannot grow this
      // list through untrusted callbacks or return an unfinished qualification.
      for(const actor of [...state.principals.values()])await state.fence(actor);
      return result;
    });}finally{state.active=false;state.results.clear();state.retained.clear();state.recency.clear();state.principals.clear();}
  }};
}

/** Only completed native reads on the explicitly registered object instances
 * may be reused. Permission, arguments and full actor identity are separate
 * keys. Concurrent misses run independently; promises/failures are not cached.
 * Without a trusted phase this is exactly the original full qualification.
 */
export async function qualifiedNativeRead<T>(reader:object,storage:StorageProvider,operation:string,args:unknown,p:PlusPrincipal,read:()=>Promise<T>):Promise<T>{
  const state=current.getStore();
  if(!state||state.storage!==storage||!state.readers.has(reader))return read();
  const actor=structuredClone(p);await state.fence(actor);
  const identity=principalKey(actor),argumentHash=digest(args),key=digest({operation,args,principal:identity}),entries=state.results.get(reader);
  const unchanged=()=>{if(principalKey(p)!==identity||digest(args)!==argumentHash)fail('NATIVE_QUALIFICATION_INPUT_CHANGED');};
  if(entries?.has(key)){const result=structuredClone(entries.get(key)) as T;await state.fence(actor);unchanged();
    // Completed dependency reads are LRU within this single fenced phase. The
    // oldest leaf must not permanently exclude every later composition node.
    const slot=state.retained.get(reader)?.get(key);
    if(slot&&state.recency.has(slot)){state.recency.delete(slot);state.recency.set(slot,true);}return result;}
  const result=await read();await state.fence(actor);unchanged();
  const bytes=Buffer.byteLength(canonicalJson(result));
  if(bytes<=16*1024*1024){
    const previous=state.retained.get(reader)?.get(key);
    if(previous){state.recency.delete(previous);state.bytes-=previous.bytes;state.entries--;}
    while(state.entries>=128||state.bytes+bytes>16*1024*1024){
      const oldest=state.recency.keys().next().value;
      if(!oldest)fail('NATIVE_QUALIFICATION_CACHE_INTEGRITY');
      state.recency.delete(oldest);state.results.get(oldest.reader)?.delete(oldest.key);state.retained.get(oldest.reader)?.delete(oldest.key);
      state.bytes-=oldest.bytes;state.entries--;
    }
    // A nested or concurrent miss may have populated this registry while read()
    // was awaiting. Reusing the pre-read map would discard qualified siblings.
    const target=state.results.get(reader)??new Map<string,unknown>();target.set(key,structuredClone(result));state.results.set(reader,target);state.entries++;state.bytes+=bytes;
    const slot={reader,key,bytes},retained=state.retained.get(reader)??new Map();retained.set(key,slot);state.retained.set(reader,retained);state.recency.set(slot,true);
  }
  return structuredClone(result);
}

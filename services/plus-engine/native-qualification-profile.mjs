import { performance } from 'node:perf_hooks';

// Test-only, bounded method timings. Never records arguments, return values,
// object identifiers, error messages, policy documents or credentials. Wraps
// actual async implementations without substituting their results. Durations
// include nested calls and must not be added together.
const installed=new WeakSet();
export async function profileNativeQualification(exports,run,{emit=()=>{},intervalMs=10000}={}){
  if(typeof run!=='function'||typeof emit!=='function'||!Number.isSafeInteger(intervalMs)||intervalMs<10)
    throw new TypeError('INVALID_NATIVE_PROFILE_OPTIONS');
  const methods=[];
  for(const [name,value] of Object.entries(exports)){
    if(!/^Native[A-Za-z0-9]+$/.test(name)||typeof value!=='function'||!value.prototype)continue;
    for(const method of Object.getOwnPropertyNames(value.prototype)){
      const descriptor=Object.getOwnPropertyDescriptor(value.prototype,method),original=descriptor?.value;
      if(!/^[A-Za-z][A-Za-z0-9]*$/.test(method)||typeof original!=='function'||original.constructor.name!=='AsyncFunction')continue;
      if(installed.has(value.prototype))throw new Error('NATIVE_PROFILE_ALREADY_ACTIVE');
      if(descriptor.configurable===false)continue;
      methods.push({prototype:value.prototype,method,descriptor,label:name+'.'+method});
    }
  }
  const prototypes=new Set(methods.map(m=>m.prototype)),rows=new Map(),restores=[],started=performance.now();
  let active=true,timer;
  const report=status=>({schema:'plus-native-method-profile-v1',status,elapsedMs:performance.now()-started,
    durationSemantics:'INCLUSIVE_NESTED_DURATIONS_NOT_ADDITIVE',
    methods:[...rows.values()].map(row=>({...row})).filter(row=>row.calls>0)
      .sort((a,b)=>b.inclusiveMs-a.inclusiveMs||a.method.localeCompare(b.method)).slice(0,40)});
  const publish=status=>{try{emit(report(status));}catch{/* Diagnostics never replace an execution result or failure. */}};
  let status='FAILED';
  try{
    for(const prototype of prototypes)installed.add(prototype);
    for(const {prototype,method,descriptor,label} of methods){
      const row={method:label,calls:0,completed:0,pending:0,failures:0,inclusiveMs:0,maxMs:0};rows.set(label,row);
      Object.defineProperty(prototype,method,{...descriptor,value:async function(...args){
        if(!active)return descriptor.value.apply(this,args);
        const at=performance.now();row.calls++;row.pending++;
        try{return await descriptor.value.apply(this,args);}
        catch(error){row.failures++;throw error;}
        finally{const elapsed=performance.now()-at;row.completed++;row.pending--;row.inclusiveMs+=elapsed;row.maxMs=Math.max(row.maxMs,elapsed);}
      }});
      restores.push(()=>Object.defineProperty(prototype,method,descriptor));
    }
    timer=setInterval(()=>publish('RUNNING'),intervalMs);timer.unref();
    const result=await run();status='RETURNED';return result;
  }finally{
    active=false;clearInterval(timer);for(const restore of restores.reverse())restore();
    for(const prototype of prototypes)installed.delete(prototype);
    publish(status);
  }
}

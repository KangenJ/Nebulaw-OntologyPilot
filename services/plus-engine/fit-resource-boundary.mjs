import {readFileSync} from 'node:fs';
const fail=()=>Object.assign(Error('FIT_ISOLATION_KERNEL_BOUNDARY_MISSING'),{code:'FIT_ISOLATION_KERNEL_BOUNDARY_MISSING'});
export const isolatedFitLimits=Object.freeze({memoryMaxBytes:1073741824,memorySwapMaxBytes:0,cpuEnforcement:'SCHEDULER_AFFINITY',maxLogicalCpus:2,tasksMax:64,runtimeMs:600000});
export function parseCpuList(value){
  if(typeof value!=='string'||value.length>65536||!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(value))throw fail();
  const ids=[];for(const entry of value.split(',')){
    const [start,end=start]=entry.split('-').map(Number);
    if(!Number.isSafeInteger(start)||start<0||end<start||end>65535)throw fail();
    for(let id=start;id<=end;id++){if(ids.length&&id<=ids.at(-1))throw fail();ids.push(id);}
  }return ids;
}
export function currentCpuIds(){
  return parseCpuList(readFileSync('/proc/self/status','utf8').match(/^Cpus_allowed_list:\s*(\S+)$/m)?.[1]);
}
// Fixed trusted worker boundary, not a hostile-code sandbox: descendants inherit
// scheduler affinity, but a malicious same-user program could change its mask.
// Verify effective kernel memory/pids/affinity before any native claim or token
// use. A systemd property alone does not prove a delegated controller exists.
export function verifyFitResourceBoundary(expectedCpuList){
  const expected=parseCpuList(expectedCpuList),actual=currentCpuIds();
  if(expected.length<1||expected.length>isolatedFitLimits.maxLogicalCpus||JSON.stringify(expected)!==JSON.stringify(actual))throw fail();
  const group=readFileSync('/proc/self/cgroup','utf8').match(/^0::(\/user\.slice\/[^\n]+\/plus-fit-job-[a-f0-9]{32}\.service)$/m)?.[1];
  if(!group||group.split('/').some(p=>p==='..'||p==='.')||group.includes('\0'))throw fail();
  try{
    const root='/sys/fs/cgroup'+group;
    for(const [name,value] of [['memory.max',isolatedFitLimits.memoryMaxBytes],['memory.swap.max',0],['pids.max',isolatedFitLimits.tasksMax]]){
      if(readFileSync(root+'/'+name,'utf8').trim()!==String(value))throw fail();
    }
  }catch{throw fail();}
  return {cpuIds:expected,...isolatedFitLimits};
}

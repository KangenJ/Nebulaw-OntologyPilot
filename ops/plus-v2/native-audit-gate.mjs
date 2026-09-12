/** Host-local reader/audit coordination, not a storage or permission bypass.
 * Concurrent HTTP operations retain their native CAS guards. Audit delivery
 * waits for a foreground idle boundary before draining. Waiting audit must
 * not freeze the UI behind a long qualification request. Under sustained
 * foreground load delivery can be delayed; committed outbox remains durable. */
export function isNativeComputeMetadataRequest(request){
  return request?.method==='GET'&&typeof request.url==='string'&&/^\/api\/plus\/v2\/compute\/jobs\/[A-Za-z0-9_-]{1,128}$/.test(request.url);
}
export function createNativeAuditGate(){
  let active=0,regular=0,barrier,closed=false;const idle=new Set();
  const failure=()=>Object.assign(Error('NATIVE_AUDIT_GATE_CLOSED'),{code:'NATIVE_AUDIT_GATE_CLOSED'});
  const waitIdle=()=>active===0?Promise.resolve():new Promise(resolve=>idle.add(resolve));
  const released=()=>{if(active===0){for(const resolve of idle)resolve();idle.clear();}};
  return {
    async foreground(operation){
      if(typeof operation!=='function')throw Error('NATIVE_AUDIT_OPERATION_REQUIRED');
      while(barrier&&(barrier.running||active===0)){if(closed)throw failure();await barrier.promise;}
      if(closed)throw failure();active++;regular++;
      try{return await operation();}finally{active--;regular--;released();}
    },
    // Only the exact authenticated native job-status GET uses this lane. It
    // retains native permission and epoch checks, and never overlaps audit.
    // A long FIT claim must not hide its own lease from the bounded monitor.
    // Once regular work drains, new metadata waits too, preventing starvation.
    async metadata(operation){
      if(typeof operation!=='function')throw Error('NATIVE_AUDIT_OPERATION_REQUIRED');
      while(barrier&&(barrier.running||regular===0)){if(closed)throw failure();await barrier.promise;}
      if(closed)throw failure();active++;
      try{return await operation();}finally{active--;released();}
    },
    async audit(operation){
      if(typeof operation!=='function')throw Error('NATIVE_AUDIT_OPERATION_REQUIRED');
      while(barrier){if(closed)throw failure();await barrier.promise;}
      if(closed)throw failure();let resolve;const token={promise:new Promise(r=>{resolve=r;})};barrier=token;
      try{await waitIdle();if(closed)throw failure();token.running=true;return await operation();}
      finally{if(barrier===token)barrier=undefined;resolve();}
    },
    state:()=>({activeForeground:active,auditWaitingOrRunning:!!barrier,closed}),
    async close(){closed=true;await Promise.all([barrier?.promise,waitIdle()]);},
  };
}

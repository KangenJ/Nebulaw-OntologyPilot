/** Host-local ordering, not a distributed lock or an authority exemption.
 * Native audit/outbox writes advance the same epoch guarded by model material
 * qualification. Do not let this host invalidate its own long selection run.
 * Other processes and HTTP writes still trigger the existing native guards. */
export function createNativeBackgroundSequence(){
  let tail=Promise.resolve(),closed=false;
  return {
    run(operation){if(typeof operation!=='function')throw Error('BACKGROUND_OPERATION_REQUIRED');
      const task=tail.then(()=>closed?undefined:operation());tail=task.catch(()=>{});return task;},
    async close(){closed=true;await tail;},
  };
}

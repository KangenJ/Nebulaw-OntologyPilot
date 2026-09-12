import { readFileSync,statSync } from 'node:fs';
import { startObservationFitWorker } from './fit-scheduler.mjs';
import {runIsolatedObservationFitJob} from './isolated-fit-runner.mjs';
try{
  const path=process.env.PLUS_WORKER_TOKEN_FILE;
  if(!path||!statSync(path).isFile()||statSync(path).size>4096)throw new Error('private token file required');
  const shutdown=new AbortController();
  const worker=startObservationFitWorker({baseUrl:process.env.PLUS_COMPUTE_URL,readToken:()=>readFileSync(path,'utf8').trim(),
    ...(process.platform==='linux'?{runJob:({baseUrl,executionId})=>runIsolatedObservationFitJob({baseUrl,executionId,tokenFile:path,signal:shutdown.signal,
      onUnit:unit=>process.stdout.write(JSON.stringify(unit)+'\n')})}:{}),
    intervalMs:Number(process.env.PLUS_WORKER_INTERVAL_MS??5000),maxJobs:1,
    onCycle:state=>process.stdout.write(JSON.stringify({schema:'plus-worker-state-v1',...state})+'\n')});
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{shutdown.abort();void worker.close().then(()=>process.exit(0));});
}catch(error){
  const code=typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{0,90}$/.test(error.code)?error.code:'FIT_WORKER_CONFIGURATION';
  process.stdout.write(JSON.stringify({schema:'plus-worker-error-v1',code})+'\n');process.exitCode=2;
}

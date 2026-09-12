import { readFileSync,statSync } from 'node:fs';
import { startBeliefWorker } from './belief-worker.mjs';
process.stdout.on('error',error=>{if(error.code!=='EPIPE')throw error;});
try{
  const path=process.env.PLUS_BELIEF_WORKER_TOKEN_FILE;
  const readToken=()=>{if(!path||!statSync(path).isFile()||statSync(path).size>4096)throw Object.assign(new Error(),{code:'BELIEF_WORKER_CREDENTIAL_INVALID'});return readFileSync(path,'utf8').trim();};
  readToken();const worker=startBeliefWorker({baseUrl:process.env.PLUS_BELIEF_CONTROL_URL,readToken,
    intervalMs:Number(process.env.PLUS_BELIEF_WORKER_INTERVAL_MS??5000),maxJobs:1,
    onCycle:state=>process.stdout.write(JSON.stringify({schema:'plus-belief-worker-state-v1',...state})+'\n')});
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void worker.close().then(()=>process.exit(0));});
}catch(error){const code=typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{0,90}$/.test(error.code)?error.code:'BELIEF_WORKER_CONFIGURATION_INVALID';
  process.stdout.write(JSON.stringify({schema:'plus-belief-worker-error-v1',code})+'\n');process.exitCode=2;
}

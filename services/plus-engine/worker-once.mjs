// Explicit one-job runner. No loop, automatic discovery, business credentials or release.
import { readFileSync,statSync } from 'node:fs';
import { runObservationFitJob } from './fit-worker.mjs';
try{
  const tokenFile=process.env.PLUS_WORKER_TOKEN_FILE;
  if(!tokenFile||!statSync(tokenFile).isFile()||statSync(tokenFile).size>4096)throw new Error('private token file required');
  const result=await runObservationFitJob({baseUrl:process.env.PLUS_COMPUTE_URL,executionId:process.env.PLUS_EXECUTION_ID,
    readToken:()=>readFileSync(tokenFile,'utf8').trim()});
  process.stdout.write(JSON.stringify({schema:'plus-worker-receipt-v1',...result})+'\n');
}catch(error){
  const code=typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{0,90}$/.test(error.code)?error.code:'FIT_WORKER_CONFIGURATION';
  process.stdout.write(JSON.stringify({schema:'plus-worker-error-v1',code})+'\n');process.exitCode=2;
}

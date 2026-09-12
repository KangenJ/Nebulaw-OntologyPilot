import { CelClient } from '../../platform/packages/actions/dist/index.js';
import { createLearnedCompositionReplayEngine } from './learned-composition.mjs';

let cel;
try{
  const address=process.env.PLUS_LEARNED_REPLAY_CEL_ADDRESS;
  if(typeof address!=='string'||!/^127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(address)||Number(address.split(':')[1])>65535)throw Object.assign(new Error(),{code:'LEARNED_REPLAY_PROCESS_CONFIGURATION_INVALID'});
  const chunks=[];let bytes=0;
  for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>32*1024*1024)throw Object.assign(new Error(),{code:'LEARNED_REPLAY_PROCESS_INPUT_LIMIT'});chunks.push(chunk);}
  const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(!input||Object.keys(input).sort().join(',')!=='request,schema'||input.schema!=='plus-learned-replay-process-request-v1')throw Object.assign(new Error(),{code:'LEARNED_REPLAY_PROCESS_REQUEST_INVALID'});
  cel=new CelClient({address,maxRetries:0,timeoutMs:2000});
  const result=await createLearnedCompositionReplayEngine({evaluateCel:(...args)=>cel.evaluate(...args)}).run(input.request);
  process.stdout.write(JSON.stringify(result)+'\n');
}catch(error){
  const code=typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{0,90}$/.test(error.code)?error.code:'LEARNED_REPLAY_PROCESS_REQUEST_INVALID';
  process.stdout.write(JSON.stringify({schema:'plus-learned-replay-process-error-v1',code})+'\n');process.exitCode=2;
}finally{cel?.close();}

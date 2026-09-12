// Fixed one-shot computation. No platform storage, credentials or job authority.
import { createObservationReplayEngine } from './online-replay.mjs';
try{
  const chunks=[];let bytes=0;
  for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>32*1024*1024)throw Object.assign(new Error(),{code:'BELIEF_PROCESS_INPUT_LIMIT'});chunks.push(chunk);}
  const input=JSON.parse(Buffer.concat(chunks).toString('utf8')),request=input?.request;
  if(!input||Object.keys(input).sort().join(',')!=='request,schema'||input.schema!=='plus-replay-process-request-v1'
    ||!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).sort().join(',')!=='candidate,clock,recipe,temporalInput,trainingMaterials')
    throw Object.assign(new Error(),{code:'BELIEF_PROCESS_REQUEST_INVALID'});
  const result=await createObservationReplayEngine().run(request);process.stdout.write(JSON.stringify(result)+'\n');
}catch(error){const code=typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{0,90}$/.test(error.code)?error.code:'BELIEF_PROCESS_REQUEST_INVALID';
  process.stdout.write(JSON.stringify({schema:'plus-replay-process-error-v1',code})+'\n');process.exitCode=2;
}

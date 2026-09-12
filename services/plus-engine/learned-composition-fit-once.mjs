// Fixed pure worker. No credentials, native writes, evaluation or deployment.
import { fitProtectedLearnedComposition } from './learned-composition-fit.mjs';
import { EngineError } from './finite-engine.mjs';
try{
  const chunks=[];let size=0;
  for await(const chunk of process.stdin){size+=chunk.length;if(size>32*1024*1024)throw new EngineError('FIT_REQUEST_SIZE');chunks.push(chunk);}
  const request=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(!request||Object.keys(request).sort().join(',')!=='materials,recipe,schema'||request.schema!=='plus-learned-composition-fit-request-v1')throw new EngineError('FIT_REQUEST_SCHEMA');
  const candidate=await fitProtectedLearnedComposition(request.recipe,request.materials);
  process.stdout.write(JSON.stringify({schema:'plus-learned-composition-fit-result-v1',candidate,deploymentAuthorized:false})+'\n');
}catch(error){
  const code=error instanceof EngineError||error?.name==='ContractError'?error.code:'FIT_INVALID_REQUEST';
  process.stdout.write(JSON.stringify({schema:'plus-learned-composition-fit-error-v1',code})+'\n');process.exitCode=2;
}

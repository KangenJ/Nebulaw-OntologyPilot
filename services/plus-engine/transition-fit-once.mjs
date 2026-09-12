// Fixed pure child: no storage, native authority, credentials or publication.
import { fitTransitionModel } from './transition-fit.mjs';
import { validatePrivateTransitionRecipe } from './native-transition-fit-verifier.mjs';
import { EngineError } from './finite-engine.mjs';
try{
  const chunks=[];let bytes=0;
  for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>32*1024*1024)throw new EngineError('FIT_REQUEST_SIZE');chunks.push(chunk);}
  const request=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(!request||Object.keys(request).sort().join(',')!=='materials,recipe,schema'||request.schema!=='plus-transition-private-fit-request-v1'
    ||!Array.isArray(request.materials)||request.materials.length!==1||request.materials[0]?.schema!=='plus-transition-fit-material-v2')throw new EngineError('FIT_REQUEST_SCHEMA');
  validatePrivateTransitionRecipe(request.recipe,request.recipe?.compiled);
  const candidate=fitTransitionModel(request.recipe,request.materials);
  process.stdout.write(JSON.stringify({schema:'plus-transition-private-fit-result-v1',candidate,deploymentAuthorized:false})+'\n');
}catch(error){
  const code=error instanceof EngineError||error?.name==='ContractError'?error.code:'FIT_INVALID_REQUEST';
  process.stdout.write(JSON.stringify({schema:'plus-transition-private-fit-error-v1',code})+'\n');process.exitCode=2;
}

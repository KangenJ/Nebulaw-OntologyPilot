import {digest} from '../../platform/packages/plus-contracts/dist/index.js';
import {createLearnedAdaptiveVerificationPlanner} from './learned-adaptive-verification-planning.mjs';

// No native DB, identity, service token, CEL endpoint or caller-selected code.
try{
  const chunks=[];let size=0;
  for await(const chunk of process.stdin){size+=chunk.length;if(size>48*1024*1024)throw Object.assign(Error(),{code:'SCENARIO_PROCESS_INPUT_LIMIT'});chunks.push(chunk);}
  let envelope;try{envelope=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Object.assign(Error(),{code:'SCENARIO_PROCESS_REQUEST_INVALID'});}
  if(!envelope||Object.keys(envelope).sort().join(',')!=='request,requestHash,schema'||envelope.schema!=='plus-adaptive-process-request-v1'||envelope.requestHash!==digest(envelope.request))throw Object.assign(Error(),{code:'SCENARIO_PROCESS_REQUEST_INVALID'});
  const result=await createLearnedAdaptiveVerificationPlanner().compare(envelope.request);
  const output=JSON.stringify({schema:'plus-adaptive-process-response-v1',requestHash:envelope.requestHash,resultHash:digest(result),result});
  if(Buffer.byteLength(output)>4*1024*1024)throw Object.assign(Error(),{code:'SCENARIO_PROCESS_OUTPUT_LIMIT'});
  process.stdout.write(output);
}catch(e){
  const code=typeof e?.code==='string'&&/^[A-Z][A-Z0-9_]{0,90}$/.test(e.code)?e.code:'SCENARIO_PROCESS_COMPUTATION_FAILED';
  process.stdout.write(JSON.stringify({schema:'plus-adaptive-process-error-v1',code}));process.exitCode=2;
}

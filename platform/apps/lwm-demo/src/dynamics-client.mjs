import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const issue=(code,message,status=503)=>Object.assign(new Error(message),{code,status});
export async function dynamicsRequest(path,body){
  const address=process.env.LWM_DYNAMICS_URL;
  if(!address||!process.env.LWM_DYNAMICS_TOKEN_FILE)throw issue('MODEL_UNAVAILABLE','Independent dynamics service is not configured');
  const url=new URL(address);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password)throw issue('MODEL_CONFIG','Demo inference transport must be private loopback');
  const token=readFileSync(process.env.LWM_DYNAMICS_TOKEN_FILE,'utf8').trim();
  let response;
  try{response=await fetch(new URL(path,url),{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000),redirect:'error'});}
  catch{throw issue('MODEL_UNAVAILABLE','Independent dynamics service unavailable; no fallback prediction was used');}
  const text=await response.text();
  if(text.length>100000)throw issue('MODEL_OUTPUT','Model output exceeds contract');
  let result;try{result=JSON.parse(text);}catch{throw issue('MODEL_OUTPUT','Invalid model service response');}
  if(!response.ok)throw issue(result.error??'MODEL_FAILURE',result.message??'Model service rejected request',response.status===422?422:503);
  if(body&&path==='/v1/simulate'){
    if(result.version!=='local-dynamics-v1-p36b61-bayes32'||result.checkpointHash!=='92579351b915f59550c56af870d14d66e554b734f7c6f9cb31a0d94b2733cd04'||result.businessFactsWritten!==false||!Array.isArray(result.options)||result.options.length!==body.options.length||!Number.isInteger(result.recommendedIndex)||!result.options[result.recommendedIndex])throw issue('MODEL_OUTPUT','Unexpected inference contract/version');
    const expectedHash=body.artifactJson&&body.artifactJson!=='null'?createHash('sha256').update(body.artifactJson).digest('hex'):result.checkpointHash;
    if(result.modelHash!==expectedHash)throw issue('MODEL_OUTPUT','Inference model does not match native registry selection');
    for(const [i,o] of result.options.entries()){
      if(o.name!==body.options[i].name||!Number.isFinite(o.baseProbability)||o.baseProbability<0||o.baseProbability>1||o.actProbability!==o.baseProbability||!Number.isFinite(o.expectedCost))throw issue('MODEL_OUTPUT','Invalid model probability/cost');
      const expected=o.baseProbability*body.options[i].costAct+(1-o.baseProbability)*body.options[i].costRefrain+body.options[i].interventionCost;
      if(Math.abs(expected-o.expectedCost)>1e-6)throw issue('MODEL_OUTPUT','Inconsistent decision cost');
    }
  }
  return result;
}

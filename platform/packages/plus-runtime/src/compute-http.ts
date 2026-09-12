import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuditRecord, DateTime } from '@openfoundry/spi';
import { NativeComputeAdmission, type ComputeAdmissionConfig } from './compute-admission.js';
import type { PlusPrincipal } from './ontology-catalog.js';

export interface PlusComputeHttpConfig {
  admission: ComputeAdmissionConfig;
  authenticate: (request: IncomingMessage) => PlusPrincipal | Promise<PlusPrincipal>;
  recordFailure: (record: AuditRecord) => Promise<unknown>;
}
const PREFIX='/api/plus/v2/compute', LIMIT=9*1024*1024;
function fail(code:string):never {throw Object.assign(new Error(code),{code});}
function object(value:unknown,fields:string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==fields.length||fields.some(k=>!Object.hasOwn(value,k)))fail('INVALID_INPUT');
  return value as Record<string,unknown>;
}
function text(value:unknown):string {if(typeof value!=='string'||!value.trim()||value.length>2000)fail('INVALID_INPUT');return value;}
function version(value:unknown):number {if(!Number.isSafeInteger(value)||Number(value)<1)fail('INVALID_VERSION');return value as number;}
async function body(req:IncomingMessage){
  if(req.headers['content-encoding']&&req.headers['content-encoding']!=='identity')fail('UNSUPPORTED_ENCODING');
  if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']??''))fail('JSON_REQUIRED');
  if(Number(req.headers['content-length']??0)>LIMIT){req.resume();fail('BODY_TOO_LARGE');}
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of req){const b=Buffer.from(chunk);size+=b.length;if(size>LIMIT)fail('BODY_TOO_LARGE');chunks.push(b);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;}catch{fail('INVALID_JSON');}
}
function publicError(error:unknown){
  const raw=(error as {code?:unknown})?.code;
  const code=typeof raw==='string'&&/^[A-Z][A-Z0-9_]{0,90}$/.test(raw)?raw:'PLUS_INTERNAL_ERROR';
  if(code==='UNAUTHENTICATED')return {status:401,code};
  if(/FORBIDDEN|NO_LONGER_AUTHORIZED/.test(code))return {status:403,code};
  if(code==='BODY_TOO_LARGE')return {status:413,code};
  if(code.endsWith('NOT_FOUND'))return {status:404,code};
  if(code==='TRANSITION_PLAN_RECIPE_NOT_PROSPECTIVE'||code==='COMPUTE_AUTHORIZATION_DATASET_SET'||/CONFLICT|STALE|LEASE|NOT_APPROVED|NOT_ELIGIBLE|NOT_AVAILABLE|MISMATCH|EXHAUSTED|SUSPENDED/.test(code))return {status:409,code};
  if(/INTEGRITY|NOT_CONFIGURED|GUARD_REQUIRED|REGISTRY_REQUIRED|VERIFIER_REQUIRED|NOT_PUBLISHED|COLLECTION_LIMIT/.test(code))return {status:503,code};
  if(/INVALID|REQUIRED|UNSUPPORTED|SIZE|WRONG_PARTITION|INSUFFICIENT/.test(code))return {status:400,code};
  return {status:500,code:'PLUS_INTERNAL_ERROR'};
}
function send(res:ServerResponse,status:number,value:unknown){
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));
}

/** Private loopback FIT transport. Mount before the broader control handler.
 * Does not start a listener, install a schema, authorize a recipe or select a worker.
 */
export function createPlusComputeHandler(config:PlusComputeHttpConfig){
  return async(req:IncomingMessage,res:ServerResponse):Promise<boolean>=>{
    const path=(req.url??'').split('?')[0]!;
    if(path!==PREFIX&&!path.startsWith(PREFIX+'/'))return false;
    const traceId=randomUUID();let principal:PlusPrincipal|undefined;
    try{
      if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress??'')||req.headers.origin)fail('COMPUTE_TRANSPORT_FORBIDDEN');
      const identity=structuredClone(await config.authenticate(req));
      if(!identity?.id||identity.tenantId!==config.admission.tenantId||!Array.isArray(identity.roles))fail('COMPUTE_FORBIDDEN');
      principal=identity;
      const reauthenticate=async()=>{
        const current=await config.authenticate(req);
        if(!current?.id||current.id!==identity.id||current.tenantId!==identity.tenantId||!Array.isArray(current.roles)
          ||JSON.stringify([...current.roles].sort())!==JSON.stringify([...identity.roles].sort()))fail('UNAUTHENTICATED');
      };
      const service=new NativeComputeAdmission({...config.admission,
        computeAuthorizations:config.admission.computeAuthorizations?{requireApproved:async(...args)=>{await reauthenticate();const result=await config.admission.computeAuthorizations!.requireApproved(...args);await reauthenticate();return result;}}:undefined,
        authorize:async(p,permission,id,purpose)=>{await reauthenticate();const allowed=purpose==='FIT'&&await config.admission.authorize(p,permission,id,purpose);await reauthenticate();return allowed;},
        policyFor:async(...args)=>{
          await reauthenticate();const policy=await config.admission.policyFor(...args);await reauthenticate();
          if(!config.admission.recipes)fail('COMPUTE_RECIPE_REGISTRY_REQUIRED');
          const verifier=policy.engineId==='ontology-composed-dynamics-v1'?config.admission.verifyLearnedCompositionFitResult
            :policy.engineId==='ontology-finite-transition-counts-v1'?config.admission.verifyTransitionFitResult:config.admission.verifyFitResult;
          if(!policy.recipeHash||typeof verifier!=='function')fail('COMPUTE_FIT_VERIFIER_REQUIRED');
          return policy;
        },
        resolvePrincipal:async id=>{await reauthenticate();const person=await config.admission.resolvePrincipal(id);await reauthenticate();return person;},
        discoveryFor:async p=>{await reauthenticate();const policy=await config.admission.discoveryFor?.(p)??null;await reauthenticate();return policy;},
      });
      const route=path.slice(PREFIX.length),match=route.match(/^\/jobs\/([A-Za-z0-9_-]{1,128})(?:\/(claim|complete-fit|fail|cancel|reconcile-exhausted|result))?$/);
      let result:unknown;
      if(req.method==='GET'&&route==='/submission-options'){
        const query=new URL(req.url!,'http://127.0.0.1').searchParams;
        if([...query.keys()].length!==1||!query.has('datasetId')||!/^[A-Za-z0-9_-]{1,128}$/.test(query.get('datasetId')??''))fail('INVALID_INPUT');
        if(!config.admission.submissionOptions)fail('COMPUTE_SUBMISSION_OPTIONS_NOT_CONFIGURED');
        await reauthenticate();result=await config.admission.submissionOptions!(identity,query.get('datasetId')!);
      }
      else if(req.method==='GET'&&route==='/submissions'){
        const query=new URL(req.url!,'http://127.0.0.1').searchParams;
        if([...query.keys()].length!==1||!query.has('datasetId'))fail('INVALID_INPUT');
        result=await service.listSubmitted(query.get('datasetId')!,identity);
      }else if(req.method==='POST'&&route==='/submissions/lookup'){
        const input=object(await body(req),['datasetId','requestKey']);
        result=await service.lookupSubmitted(text(input.datasetId),text(input.requestKey),identity);
      }
      else if(req.method==='GET'&&route==='/jobs')result=await service.discover(identity);
      else if(req.method==='POST'&&route==='/jobs'){
        const raw=await body(req),batch=!!raw&&typeof raw==='object'&&Object.hasOwn(raw,'datasetIds');
        const selected=!!raw&&typeof raw==='object'&&Object.hasOwn(raw,'authorization');
        const input=object(raw,[batch?'datasetIds':'datasetId','purpose',...(selected?['authorization']:[])]),key=req.headers['idempotency-key'];
        if(typeof key!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(key))fail('IDEMPOTENCY_REQUIRED');
        if(input.purpose!=='FIT')fail('COMPUTE_PURPOSE_UNSUPPORTED');
        if(batch&&(!Array.isArray(input.datasetIds)||input.datasetIds.length<2||input.datasetIds.length>10))fail('COMPUTE_INVALID_DATASET_SET');
        const ref=selected?object(input.authorization,['key','version']):undefined;
        result=await service.enqueue(batch?(input.datasetIds as unknown[]).map(text):text(input.datasetId),'FIT',identity,key,ref?{key:text(ref.key),version:version(ref.version)}:undefined);
      }else if(match){
        const id=match[1]!,operation=match[2];
        if(req.method==='GET'&&!operation)result=await service.inspect(id,identity);
        else if(req.method==='GET'&&operation==='result')result=await service.readFitResult(id,identity);
        else if(req.method==='POST'&&operation&&operation!=='result'){
          const fields=operation==='claim'?[]:operation==='complete-fit'?['expectedVersion','leaseToken','artifact']:operation==='fail'?['expectedVersion','leaseToken','errorCode']:['expectedVersion'];
          const input=object(await body(req),fields);
          if(operation==='claim')result=await service.claim(id,identity);
          else if(operation==='complete-fit'){
            if(!input.artifact||typeof input.artifact!=='object'||Array.isArray(input.artifact))fail('INVALID_INPUT');
            result=await service.completeFit(id,version(input.expectedVersion),text(input.leaseToken),input.artifact as Record<string,unknown>,identity);
          }else if(operation==='fail')result=await service.fail(id,version(input.expectedVersion),text(input.leaseToken),text(input.errorCode),identity);
          else if(operation==='cancel')result=await service.cancel(id,version(input.expectedVersion),identity);
          else result=await service.reconcileExhausted(id,version(input.expectedVersion),identity);
        }else fail('NOT_FOUND');
      }else fail('NOT_FOUND');
      // Includes POST claim: never deliver training data after credential revocation.
      await reauthenticate();send(res,200,{data:result,traceId});
    }catch(error){
      let exposed=publicError(error);
      if(principal&&req.method==='POST'){
        try{await config.recordFailure({id:'audit_'+randomUUID(),tenantId:principal.tenantId,timestamp:new Date().toISOString() as DateTime,traceId,
          actor:{id:principal.id,type:'user',roles:[...principal.roles]},operation:{type:'action',actionType:'PlusComputeRequest'},
          detail:{result:exposed.status===401||exposed.status===403?'denied':'error',denialReason:exposed.code}});}
        catch{exposed={status:503,code:'AUDIT_UNAVAILABLE'};}
      }
      send(res,exposed.status,{error:{code:exposed.code},traceId});
    }
    return true;
  };
}

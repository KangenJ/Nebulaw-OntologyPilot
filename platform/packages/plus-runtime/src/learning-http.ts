import { randomUUID } from 'node:crypto';
import type { IncomingMessage,ServerResponse } from 'node:http';
import type { AuditRecord,DateTime } from '@openfoundry/spi';
import type { PlusPrincipal } from './ontology-catalog.js';
import type { NativePartitionLedger } from './partition-ledger.js';
import type { NativeFeedbackRegistry } from './feedback-registry.js';
import type { NativeDatasetRegistry } from './dataset-registry.js';
import type { NativeRecipeRegistry } from './recipe-registry.js';
import type { NativeComputeAuthorization } from './compute-authorization.js';
import type { NativeEvaluationProtocolRegistry } from './evaluation-protocol-registry.js';
import type { NativeModelEvaluation } from './model-evaluation.js';
import type { NativeModelDecision } from './model-decision.js';
import type { NativeModelDeployment } from './model-deployment.js';
import type { NativeReplayAuthorization } from './replay-authorization.js';
import type { NativeBeliefRuntime } from './belief-runtime.js';
import type { NativeBeliefJobs } from './belief-jobs.js';
import type { NativeModelSelectionJobs } from './model-selection-jobs.js';
import type { NativeModelEvaluationJobs } from './model-evaluation-jobs.js';
import type { NativeModelDecisionJobs } from './model-decision-jobs.js';
import type { NativeActionExecutionJobs } from './action-execution-jobs.js';
import type { NativeScenarioRuntime } from './scenario-runtime.js';
import type { NativeActionRequests } from './action-request.js';
import type { NativeRuleRegistry } from './rule-registry.js';
import type { NativeRuleRuntime } from './rule-runtime.js';

export interface LearningServices {
  partitions:Pick<NativePartitionLedger,'reserve'|'read'>;
  feedback:Pick<NativeFeedbackRegistry,'propose'|'read'|'review'>&Partial<Pick<NativeFeedbackRegistry,'listForRoot'|'proposalOptions'|'preview'>>;
  datasets:Pick<NativeDatasetRegistry,'proposeCohort'|'readCohort'|'reviewCohort'|'freeze'|'inspect'>&{
    listForRoot?:(root:{type:string;id:string},p:PlusPrincipal)=>Promise<unknown>;
    frozenForRoot?:(root:{type:string;id:string},p:PlusPrincipal)=>Promise<unknown>;
    proposalOptions?:(root:{type:string;id:string},p:PlusPrincipal)=>Promise<unknown>};
  recipes:Pick<NativeRecipeRegistry,'propose'|'readRevision'|'listRevisions'|'review'|'revoke'>&Partial<Pick<NativeRecipeRegistry,'decisionMetadata'>>;
  recipeWorkbench?:{read(p:PlusPrincipal):Promise<unknown>;options(input:unknown,p:PlusPrincipal):Promise<unknown>;preview(input:unknown,p:PlusPrincipal):Promise<unknown>};
  computeAuthorizations?:Pick<NativeComputeAuthorization,'propose'|'list'|'review'|'revoke'>;
  computeAuthorizationPurposes?:{read:(p:PlusPrincipal)=>Promise<unknown>};
  computeAuthorizationWorkbench?:{proposalOptions:(input:{key:string;rootType:string;rootId:string;baseRevision?:number},p:PlusPrincipal)=>Promise<unknown>;
    reviewDetails:(input:{key:string;revision:number},p:PlusPrincipal)=>Promise<unknown>};
  evaluationProtocols?:Pick<NativeEvaluationProtocolRegistry,'propose'|'read'|'review'|'revoke'>;
  modelEvaluations?:Pick<NativeModelEvaluation,'evaluate'|'read'>;
  modelDecisions?:Pick<NativeModelDecision,'decide'|'read'|'revoke'|'listForSelection'>;
  modelDeployments?:Pick<NativeModelDeployment,'activate'|'rollback'|'read'>&Partial<Pick<NativeModelDeployment,'listAvailable'|'listRevisions'|'readRevision'>>;
  replayAuthorizations?:Pick<NativeReplayAuthorization,'approve'|'read'|'revoke'>&Partial<Pick<NativeReplayAuthorization,'listForSelection'>>;
  beliefs?:Pick<NativeBeliefRuntime,'replay'|'readCurrent'>&Partial<Pick<NativeBeliefRuntime,'replayPosition'>>;
  beliefJobs?:Pick<NativeBeliefJobs,'enqueue'|'claim'|'run'|'failAttempt'|'cancel'|'reconcileExhausted'|'read'|'discover'>&Partial<Pick<NativeBeliefJobs,'lookup'>>;
  selectionJobs?:Pick<NativeModelSelectionJobs,'enqueue'|'claim'|'run'|'failAttempt'|'cancel'|'reconcileExhausted'|'read'|'listOwn'|'lookup'|'discover'>;
  evaluationJobs?:Pick<NativeModelEvaluationJobs,'enqueue'|'claim'|'run'|'failAttempt'|'cancel'|'reconcileExhausted'|'read'|'listOwn'|'lookup'|'discover'>;
  decisionJobs?:Pick<NativeModelDecisionJobs,'enqueue'|'claim'|'run'|'failAttempt'|'cancel'|'reconcileExhausted'|'read'|'listOwn'|'lookup'|'discover'>;
  actionExecutionJobs?:Pick<NativeActionExecutionJobs,'enqueue'|'cancel'|'read'|'listOwn'|'lookup'>;
  actionExecutionCatalog?:{read:(p:PlusPrincipal)=>Promise<unknown>};
  actionReviewCatalog?:{read:(p:PlusPrincipal)=>Promise<unknown>};
  actionProposalCatalog?:{read:(p:PlusPrincipal)=>Promise<unknown>;lookup:(input:{requestKey:string},p:PlusPrincipal)=>Promise<unknown>};
  evaluationOptions?:{read:(input:{datasetId:string;executionId:string},p:PlusPrincipal)=>Promise<unknown>};
  modelReview?:{read:(p:PlusPrincipal)=>Promise<unknown>};
  scenarios?:Pick<NativeScenarioRuntime,'compare'|'read'>;
  scenarioWorkbench?:{options:(input:{rootType:string;rootId:string},p:PlusPrincipal)=>Promise<unknown>;
    lookup:(input:{rootType:string;rootId:string;requestKey:string},p:PlusPrincipal)=>Promise<unknown>;
    view:(input:{rootType:string;rootId:string;scenarioId:string},p:PlusPrincipal)=>Promise<unknown>};
  actionRequests?:Pick<NativeActionRequests,'submit'|'read'|'decide'|'execute'>;
  ruleSpecifications?:Pick<NativeRuleRegistry,'propose'|'listRevisions'|'readRevision'|'review'|'revoke'>&Partial<Pick<NativeRuleRegistry,'decisionMetadata'>>;
  ruleResults?:Pick<NativeRuleRuntime,'evaluate'|'readCurrent'>;
  ruleWorkbench?:{read:(p:PlusPrincipal)=>Promise<unknown>;options:(input:{key:string;definitionKey:string},p:PlusPrincipal)=>Promise<unknown>};
}
export interface PlusLearningHttpConfig {
  tenantId:string;
  authenticate:(req:IncomingMessage)=>PlusPrincipal|Promise<PlusPrincipal>;
  /** Server-owned native adapters MUST call this request fence at permission/commit gates. */
  createServices:(context:{reauthenticate:()=>Promise<void>})=>LearningServices|Promise<LearningServices>;
  recordFailure:(record:AuditRecord)=>Promise<unknown>;
  /** Optional explicit local UI origins, e.g. an approved loopback gateway. No wildcard/CORS reflection. */
  allowedOrigins?:readonly string[];
}
const PREFIX='/api/plus/v2/learning',LIMIT=9*1024*1024;
function fail(code:string):never {throw Object.assign(new Error(code),{code});}
const loopback=(host:string)=>['127.0.0.1','[::1]'].includes(host);
function localOrigin(value:string){try{const u=new URL(value);return u.protocol==='http:'&&loopback(u.hostname)&&!!u.port&&!u.username&&!u.password&&u.origin===value;}catch{return false;}}
function object(raw:unknown,names:string[]):Record<string,unknown>{if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length!==names.length||names.some(n=>!Object.hasOwn(raw,n)))fail('INVALID_INPUT');return raw as Record<string,unknown>;}
function text(raw:unknown):string{if(typeof raw!=='string'||!raw.trim()||raw.length>2000)fail('INVALID_INPUT');return raw;}
function id(raw:unknown):string{const v=text(raw);if(!/^[A-Za-z0-9_-]{1,128}$/.test(v))fail('INVALID_REFERENCE');return v;}
function key(raw:unknown):string{const v=text(raw);if(!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(v))fail('INVALID_KEY');return v;}
function version(raw:unknown):number{if(!Number.isSafeInteger(raw)||Number(raw)<1)fail('INVALID_VERSION');return raw as number;}
function decision(raw:unknown):'APPROVE'|'REJECT'{if(raw!=='APPROVE'&&raw!=='REJECT')fail('INVALID_DECISION');return raw;}
function ids(raw:unknown):string[]{if(!Array.isArray(raw)||raw.length<1||raw.length>100)fail('INVALID_MEMBERS');const values=raw.map(id);if(new Set(values).size!==values.length)fail('INVALID_MEMBERS');return values;}
async function body(req:IncomingMessage){
  if(req.headers['content-encoding']&&req.headers['content-encoding']!=='identity')fail('UNSUPPORTED_ENCODING');
  if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']??''))fail('JSON_REQUIRED');
  if(Number(req.headers['content-length']??0)>LIMIT){req.resume();fail('BODY_TOO_LARGE');}
  const chunks:Buffer[]=[];let size=0;for await(const chunk of req){const b=Buffer.from(chunk);size+=b.length;if(size>LIMIT)fail('BODY_TOO_LARGE');chunks.push(b);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;}catch{fail('INVALID_JSON');}
}
function publicError(error:unknown){
  const contextCode=(error as {code?:unknown})?.code;
  if(typeof contextCode==='string'&&/^CONTEXT_HISTORY_(?:INSUFFICIENT|CHANGE_TIME_REQUIRED|RECEIPT_REVERSED|TIME_ORDER|PARTIAL_TIME|INITIAL_CLOCK_CHANGED|INITIAL_REENTRY)$/.test(contextCode))return {status:409,code:contextCode};
  const raw=(error as {code?:unknown})?.code,code=typeof raw==='string'&&/^[A-Z][A-Z0-9_]{0,90}$/.test(raw)?raw:'PLUS_INTERNAL_ERROR';
  if(code==='UNAUTHENTICATED')return {status:401,code};
  if(/^SCENARIO_PROCESS_(?:TIMEOUT|OUTPUT_LIMIT|INPUT_LIMIT|ABORTED|START_FAILED|EXIT_FAILED|RESPONSE_INVALID|COMPUTATION_FAILED)$/.test(code))return {status:503,code};
  if(code==='SCENARIO_PROCESS_BUSY')return {status:429,code};
  if(code==='SELECTION_JOB_LEASE_EXPIRED'||code==='SELECTION_JOB_ATTEMPTS_EXHAUSTED')return {status:409,code};
  if(code==='EVALUATION_JOB_LEASE_EXPIRED'||code==='EVALUATION_JOB_ATTEMPTS_EXHAUSTED')return {status:409,code};
  if(code==='DECISION_JOB_LEASE_EXPIRED'||code==='DECISION_JOB_ATTEMPTS_EXHAUSTED')return {status:409,code};
  // Only known code-owned replay child failures are recoverable worker signals.
  // Do not expose arbitrary engine messages or turn transport ambiguity into a
  // confirmed failure. The worker re-reads the native lease/receipt before fail.
  if(/^(?:BELIEF_PROCESS_(?:TIMEOUT|OUTPUT_LIMIT|ABORTED|START_FAILED|EXIT_FAILED|RESPONSE_INVALID)|COMPOSITION_PROCESS_(?:TIMEOUT|OUTPUT_LIMIT|START_FAILED|EXIT_FAILED|RESPONSE_INVALID))$/.test(code))return {status:503,code};
  if(/FORBIDDEN|NO_LONGER_AUTHORIZED/.test(code))return {status:403,code};
  if(code==='BODY_TOO_LARGE')return {status:413,code};
  if(code==='SCENARIO_ADAPTIVE_BUDGET'||code==='SCENARIO_ADAPTIVE_CLOCK_BUDGET'||code==='ADAPTIVE_VERIFICATION_BRANCH_BUDGET'||code==='ADAPTIVE_VERIFICATION_BUDGET')return {status:400,code};
  if(code.endsWith('NOT_FOUND'))return {status:404,code};
  if(code==='EPISODE_CURRENT_CAPTURE_REQUIRED'||code==='BELIEF_JOB_LEASE_EXPIRED'||code==='BELIEF_JOB_ATTEMPTS_EXHAUSTED'||code==='SCENARIO_BELIEF_NOT_CURRENT'||code==='RULE_RESULT_OBSERVATION_AMBIGUOUS')return {status:409,code};
  if(/CONFIGURATION|INTEGRITY|NOT_CONFIGURED|UNAVAILABLE|GUARD_REQUIRED|COLLECTION_LIMIT|REGISTRY_REQUIRED/.test(code))return {status:503,code};
  if(/CONFLICT|STALE|NOT_ELIGIBLE|NOT_APPROVED|NOT_PUBLISHED|NOT_RESERVED|SUSPENDED|REVOKED|WINDOW_OPEN|ENROLLMENT_CLOSED|REGISTRATION_CLOSED|IMMATURE|INDEPENDENT_REVIEW|NON_MONOTONIC|REGRESSION|MISMATCH|ALREADY_SELECTED/.test(code))return {status:409,code};
  if(/INVALID|REQUIRED|UNSUPPORTED|SIZE|WRONG_PARTITION|INSUFFICIENT|^FIT_/.test(code))return {status:400,code};
  return {status:500,code:'PLUS_INTERNAL_ERROR'};
}
function send(res:ServerResponse,status:number,value:unknown){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));}

/** Native learning, admission and selection lifecycle. No materialize/export,
 * caller-supplied scoring or arbitrary write API. Optional replay accepts only
 * native approved authorization/snapshot references, never model inputs. */
export function createPlusLearningHandler(config:PlusLearningHttpConfig){
  const allowed=[...(config.allowedOrigins??[])];if(allowed.length>10||allowed.some(v=>!localOrigin(v)))fail('LEARNING_ORIGIN_CONFIGURATION_INVALID');
  return async(req:IncomingMessage,res:ServerResponse):Promise<boolean>=>{
    const path=(req.url??'').split('?')[0]!;if(path!==PREFIX&&!path.startsWith(PREFIX+'/'))return false;
    const traceId=randomUUID();let principal:PlusPrincipal|undefined;
    // IncomingMessage close is normal after reading a complete body. Only an
    // aborted request or an unfinished response's close denotes disconnect.
    const cancellation=new AbortController(),onAborted=()=>cancellation.abort(),onClosed=()=>{if(!res.writableFinished)cancellation.abort();};
    req.once('aborted',onAborted);res.once('close',onClosed);if(req.aborted||res.destroyed)onAborted();
    try{
      if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress??''))fail('LEARNING_TRANSPORT_FORBIDDEN');
      const origin=req.headers.origin;
      if(origin&&(!localOrigin(origin)||!allowed.includes(origin)&&new URL(origin).port!==String(req.socket.localPort)))fail('LEARNING_ORIGIN_FORBIDDEN');
      const identity=structuredClone(await config.authenticate(req));
      if(!identity?.id||identity.tenantId!==config.tenantId||!Array.isArray(identity.roles))fail('LEARNING_FORBIDDEN');principal=identity;
      const reauthenticate=async()=>{const p=await config.authenticate(req);if(!p?.id||p.id!==identity.id||p.tenantId!==identity.tenantId||!Array.isArray(p.roles)
        ||JSON.stringify([...p.roles].sort())!==JSON.stringify([...identity.roles].sort()))fail('UNAUTHENTICATED');};
      const s=await config.createServices({reauthenticate});await reauthenticate();
      const route=path.slice(PREFIX.length),record=route.match(/^\/(partitions|feedback|cohorts|datasets)\/([A-Za-z0-9_-]{1,128})(?:\/(review|freeze))?$/),
        recipe=route.match(/^\/recipes\/([A-Za-z][A-Za-z0-9_.-]{0,127})\/revisions(?:\/([A-Za-z0-9_-]{1,128}))?$/),
        recipeAction=route.match(/^\/recipes\/([A-Za-z0-9_-]{1,128})\/(review|revoke)$/),
        recipeDecision=route.match(/^\/recipes\/([A-Za-z][A-Za-z0-9_.-]{0,127})\/revisions\/([A-Za-z0-9_-]{1,128})\/decision$/),
        evaluationProtocol=route.match(/^\/evaluation-protocols\/([A-Za-z0-9_-]{1,128})(?:\/(review|revoke))?$/),
        modelDecision=route.match(/^\/model-decisions\/([A-Za-z0-9_-]{1,128})(?:\/(revoke))?$/),
        modelEvaluation=route.match(/^\/model-evaluations\/([A-Za-z0-9_-]{1,128})$/),
        modelDeployment=route.match(/^\/deployments\/([A-Za-z][A-Za-z0-9_.-]{0,127})$/),
        modelRevision=route.match(/^\/deployments\/([A-Za-z][A-Za-z0-9_.-]{0,127})\/revisions(?:\/([A-Za-z0-9_-]{1,128}))?$/),
        replayAuthorization=route.match(/^\/replay-authorizations\/([A-Za-z0-9_-]{1,128})(?:\/(revoke))?$/),
        currentBelief=route.match(/^\/beliefs\/([A-Za-z][A-Za-z0-9_.-]{0,127})\/episodes\/([A-Za-z0-9_-]{1,128})$/),
        beliefPosition=route.match(/^\/beliefs\/([A-Za-z][A-Za-z0-9_.-]{0,127})\/episodes\/([A-Za-z0-9_-]{1,128})\/position$/),
        beliefJob=route.match(/^\/belief-jobs\/([A-Za-z0-9_-]{1,128})(?:\/(claim|run|fail|cancel|reconcile-exhausted))?$/),
        selectionJob=route.match(/^\/selection-jobs\/([A-Za-z0-9_-]{1,128})(?:\/(claim|run|fail|cancel|reconcile-exhausted))?$/),
        evaluationJob=route.match(/^\/evaluation-jobs\/([A-Za-z0-9_-]{1,128})(?:\/(claim|run|fail|cancel|reconcile-exhausted))?$/),
        decisionJob=route.match(/^\/decision-jobs\/([A-Za-z0-9_-]{1,128})(?:\/(claim|run|fail|cancel|reconcile-exhausted))?$/),
        actionExecutionJob=route.match(/^\/action-execution-jobs\/([A-Za-z0-9_-]{1,128})(?:\/(cancel))?$/),
        scenario=route.match(/^\/scenarios\/([A-Za-z0-9_-]{1,128})$/),
        actionRequest=route.match(/^\/action-requests\/([A-Za-z0-9_-]{1,128})(?:\/(decisions|execute))?$/),
        ruleRevision=route.match(/^\/rule-specifications\/([A-Za-z][A-Za-z0-9_.-]{0,127})\/revisions(?:\/([A-Za-z0-9_-]{1,128}))?$/),
        ruleAction=route.match(/^\/rule-specifications\/([A-Za-z0-9_-]{1,128})\/(review|revoke)$/),
        ruleDecision=route.match(/^\/rule-specifications\/([A-Za-z][A-Za-z0-9_.-]{0,127})\/revisions\/([A-Za-z0-9_-]{1,128})\/decision$/),
        ruleResult=route.match(/^\/rule-results\/([A-Za-z0-9_-]{1,128})$/);
      let result:unknown;
      const computeAuthorizationHistory=route.match(/^\/compute-authorizations\/([A-Za-z][A-Za-z0-9_.-]{0,127})\/revisions$/),
        computeAuthorizationAction=route.match(/^\/compute-authorizations\/([A-Za-z0-9_-]{1,128})\/(review|revoke)$/);
      if(route==='/compute-authorization-options'||route==='/compute-authorization-review'){
        if(req.method!=='GET')fail('NOT_FOUND');if(!s.computeAuthorizationWorkbench)fail('COMPUTE_AUTHORIZATION_NOT_CONFIGURED');
        const query=new URL(req.url!,'http://127.0.0.1').searchParams,proposal=route==='/compute-authorization-options',base=proposal&&query.has('baseRevision'),names=proposal?['key','rootType','rootId',...(base?['baseRevision']:[])]:['key','revision'];
        if([...query.keys()].length!==names.length||names.some(n=>!query.has(n)))fail('INVALID_INPUT');
        if(proposal){if(base&&!/^[1-9][0-9]*$/.test(query.get('baseRevision')??''))fail('INVALID_VERSION');
          result=await s.computeAuthorizationWorkbench.proposalOptions({key:key(query.get('key')),rootType:id(query.get('rootType')),rootId:id(query.get('rootId')),...(base?{baseRevision:version(Number(query.get('baseRevision')))}:{})},identity);}
        else {if(!/^[1-9][0-9]*$/.test(query.get('revision')??''))fail('INVALID_VERSION');result=await s.computeAuthorizationWorkbench.reviewDetails({key:key(query.get('key')),revision:version(Number(query.get('revision')))},identity);}
      }else if(route==='/compute-authorization-purposes'){
        if(req.method!=='GET')fail('NOT_FOUND');if(!s.computeAuthorizationPurposes)fail('COMPUTE_AUTHORIZATION_NOT_CONFIGURED');
        if((req.url??'').includes('?'))fail('INVALID_INPUT');result=await s.computeAuthorizationPurposes.read(identity);
      }else if(route==='/compute-authorizations'||computeAuthorizationHistory||computeAuthorizationAction){
        const registry=s.computeAuthorizations;if(!registry)fail('COMPUTE_AUTHORIZATION_NOT_CONFIGURED');
        if((req.url??'').includes('?'))fail('INVALID_INPUT');
        if(req.method==='POST'&&route==='/compute-authorizations'){
          const v=object(await body(req),['key','revision','datasetIds','recipeHash']),datasetIds=ids(v.datasetIds);
          if(datasetIds.length>10||typeof v.recipeHash!=='string'||!/^[a-f0-9]{64}$/.test(v.recipeHash))fail('INVALID_INPUT');
          result=await registry.propose({key:key(v.key),revision:version(v.revision),datasetIds,recipeHash:v.recipeHash},identity);
        }else if(req.method==='GET'&&computeAuthorizationHistory)result=await registry.list(computeAuthorizationHistory[1]!,identity);
        else if(req.method==='POST'&&computeAuthorizationAction){
          const revoke=computeAuthorizationAction[2]==='revoke',v=object(await body(req),revoke?['expectedVersion','reason']:['expectedVersion','decision','reason']);
          result=revoke?await registry.revoke(computeAuthorizationAction[1]!,version(v.expectedVersion),text(v.reason),identity)
            :await registry.review(computeAuthorizationAction[1]!,version(v.expectedVersion),decision(v.decision),text(v.reason),identity);
        }else fail('NOT_FOUND');
      }else if(['/recipes/options','/recipes/authoring-options','/recipes/preview'].includes(route)){
        if(new URL(req.url!,'http://127.0.0.1').search)fail('INVALID_INPUT');const reader=s.recipeWorkbench;if(!reader)fail('RECIPE_WORKBENCH_NOT_CONFIGURED');
        if(route==='/recipes/options'&&req.method==='GET')result=await reader!.read(identity);
        else if(route==='/recipes/authoring-options'&&req.method==='POST')result=await reader!.options(await body(req),identity);
        else if(route==='/recipes/preview'&&req.method==='POST')result=await reader!.preview(await body(req),identity);else fail('NOT_FOUND');
      }else if(recipeDecision){
        if(req.method!=='GET')fail('NOT_FOUND');if(new URL(req.url!,'http://127.0.0.1').search)fail('INVALID_INPUT');if(!s.recipes.decisionMetadata)fail('RECIPE_WORKBENCH_NOT_CONFIGURED');
        result=await s.recipes.decisionMetadata!(recipeDecision[1]!,recipeDecision[2]!,identity);
      }else if(route==='/rule-specifications/options'||route==='/rule-specifications/authoring-options'){
        if(new URL(req.url!,'http://127.0.0.1').search)fail('INVALID_INPUT');
        const reader=s.ruleWorkbench;if(!reader)fail('RULE_WORKBENCH_NOT_CONFIGURED');
        if(route.endsWith('/authoring-options')&&req.method==='POST'){
          const v=object(await body(req),['key','definitionKey']);result=await reader!.options({key:key(v.key),definitionKey:key(v.definitionKey)},identity);
        }else if(route.endsWith('/options')&&req.method==='GET')result=await reader!.read(identity);
        else fail('NOT_FOUND');
      }else if(ruleDecision){
        if(req.method!=='GET')fail('NOT_FOUND');if(new URL(req.url!,'http://127.0.0.1').search)fail('INVALID_INPUT');
        const registry=s.ruleSpecifications;if(!registry?.decisionMetadata)fail('RULE_REGISTRY_NOT_CONFIGURED');
        result=await registry!.decisionMetadata!(ruleDecision[1]!,ruleDecision[2]!,identity);
      }else if(route==='/rule-specifications'||ruleRevision||ruleAction){
        const registry=s.ruleSpecifications;if(!registry)fail('RULE_REGISTRY_NOT_CONFIGURED');
        if(req.method==='POST'&&route==='/rule-specifications'){
          const v=object(await body(req),['key','revision','definitionKey','specification']);
          if(!v.specification||typeof v.specification!=='object'||Array.isArray(v.specification))fail('INVALID_INPUT');
          result=await registry.propose({key:key(v.key),revision:version(v.revision),definitionKey:key(v.definitionKey),specification:v.specification as Record<string,unknown>},identity);
        }else if(req.method==='GET'&&ruleRevision)result=ruleRevision[2]?await registry.readRevision(ruleRevision[1]!,ruleRevision[2],identity):await registry.listRevisions(ruleRevision[1]!,identity);
        else if(req.method==='POST'&&ruleAction){
          const revoke=ruleAction[2]==='revoke',v=object(await body(req),revoke?['expectedVersion','reason']:['expectedVersion','decision','reason']);
          result=revoke?await registry.revoke(ruleAction[1]!,version(v.expectedVersion),text(v.reason),identity):await registry.review(ruleAction[1]!,version(v.expectedVersion),decision(v.decision),text(v.reason),identity);
        }else fail('NOT_FOUND');
      }else if(route==='/rule-results'||ruleResult){
        const registry=s.ruleResults;if(!registry)fail('RULE_RUNTIME_NOT_CONFIGURED');
        if(req.method==='POST'&&route==='/rule-results'){
          const v=object(await body(req),['key','episodeId','snapshotId','specificationHash','requestKey']);
          if(typeof v.specificationHash!=='string'||!/^[a-f0-9]{64}$/.test(v.specificationHash))fail('INVALID_INPUT');
          result=await registry.evaluate({key:key(v.key),episodeId:id(v.episodeId),snapshotId:id(v.snapshotId),specificationHash:v.specificationHash,requestKey:text(v.requestKey)},identity);
        }else if(req.method==='GET'&&ruleResult)result=await registry.readCurrent(ruleResult[1]!,identity);else fail('NOT_FOUND');
      }else if(route==='/action-requests/proposal-options'||route==='/action-requests/lookup'){
        const reader=s.actionProposalCatalog;if(!reader)fail('ACTION_PROPOSAL_NOT_CONFIGURED');
        if(new URL(req.url!,'http://127.0.0.1').search)fail('INVALID_INPUT');
        if(route.endsWith('/proposal-options')&&req.method==='GET')result=await reader!.read(identity);
        else if(route.endsWith('/lookup')&&req.method==='POST'){const v=object(await body(req),['requestKey']);result=await reader!.lookup({requestKey:text(v.requestKey)},identity);}
        else fail('NOT_FOUND');
      }else if(route==='/action-requests/review-options'){
        if(req.method!=='GET')fail('NOT_FOUND');if(new URL(req.url!,'http://127.0.0.1').search)fail('INVALID_INPUT');
        if(!s.actionReviewCatalog)fail('ACTION_REVIEW_NOT_CONFIGURED');result=await s.actionReviewCatalog!.read(identity);
      }else if(route==='/action-requests'||actionRequest){
        const registry=s.actionRequests;if(!registry)fail('ACTION_REQUEST_NOT_CONFIGURED');
        if(req.method==='POST'&&route==='/action-requests'){
          const v=object(await body(req),['scenarioId','optionKey','actionName','params','reason','requestKey']);
          if(!v.params||typeof v.params!=='object'||Array.isArray(v.params))fail('INVALID_INPUT');
          result=await registry.submit({scenarioId:id(v.scenarioId),optionKey:key(v.optionKey),actionName:key(v.actionName),params:v.params as Record<string,unknown>,reason:text(v.reason),requestKey:text(v.requestKey)},identity);
        }else if(req.method==='GET'&&actionRequest&&!actionRequest[2])result=await registry.read(actionRequest[1]!,identity);
        else if(req.method==='POST'&&actionRequest?.[2]){
          const execute=actionRequest[2]==='execute',v=object(await body(req),execute?['expectedVersion']:['expectedVersion','decision','reason']);
          const input={requestId:actionRequest[1]!,expectedVersion:version(v.expectedVersion)};
          result=execute?await registry.execute(input,identity):await registry.decide({...input,decision:decision(v.decision),reason:text(v.reason)},identity);
        }else fail('NOT_FOUND');
      }else if(['/scenarios/options','/scenarios/lookup','/scenarios/view'].includes(route)){
        const w=s.scenarioWorkbench,url=new URL(req.url!,'http://127.0.0.1');if(!w)fail('SCENARIO_WORKBENCH_NOT_CONFIGURED');
        if(route==='/scenarios/options'&&req.method==='GET'){
          if([...url.searchParams.keys()].sort().join(',')!=='rootId,rootType')fail('INVALID_INPUT');
          result=await w.options({rootType:key(url.searchParams.get('rootType')),rootId:id(url.searchParams.get('rootId'))},identity);
        }else if(req.method==='POST'&&route!=='/scenarios/options'){
          if(url.search)fail('INVALID_INPUT');const lookup=route==='/scenarios/lookup',v=object(await body(req),['rootType','rootId',lookup?'requestKey':'scenarioId']);
          const root={rootType:key(v.rootType),rootId:id(v.rootId)};
          result=lookup?await w.lookup({...root,requestKey:text(v.requestKey)},identity):await w.view({...root,scenarioId:id(v.scenarioId)},identity);
        }else fail('NOT_FOUND');
      }else if(route==='/scenarios'||scenario){
        const registry=s.scenarios;if(!registry)fail('SCENARIO_NOT_CONFIGURED');
        if(req.method==='POST'&&route==='/scenarios'){
          const raw=await body(req);
          if(raw&&typeof raw==='object'&&!Array.isArray(raw)&&(raw as Record<string,unknown>).schema==='plus-native-adaptive-scenario-input-v1'){
            const v=object(raw,['schema','key','episodeId','beliefId','requestKey','assumptionId','assumptionHash']);
            result=await registry.compare({schema:'plus-native-adaptive-scenario-input-v1',key:key(v.key),episodeId:id(v.episodeId),beliefId:id(v.beliefId),requestKey:text(v.requestKey),assumptionId:key(v.assumptionId),assumptionHash:text(v.assumptionHash)},identity,cancellation.signal);
          }else{
          const v=object(raw,['key','episodeId','beliefId','requestKey','availabilityProbability']);
          if(typeof v.availabilityProbability!=='number'||!Number.isFinite(v.availabilityProbability)||v.availabilityProbability<0||v.availabilityProbability>1)fail('INVALID_INPUT');
          result=await registry.compare({key:key(v.key),episodeId:id(v.episodeId),beliefId:id(v.beliefId),requestKey:text(v.requestKey),availabilityProbability:v.availabilityProbability},identity);
          }
        }else if(req.method==='GET'&&scenario)result=await registry.read(scenario[1]!,identity);else fail('NOT_FOUND');
      }else if(route==='/evaluation-jobs'||evaluationJob){
        const jobs=s.evaluationJobs,url=new URL(req.url!,'http://127.0.0.1');if(!jobs)fail('EVALUATION_JOBS_NOT_CONFIGURED');
        if(req.method==='GET'&&route==='/evaluation-jobs/options'){
          if([...url.searchParams.keys()].sort().join(',')!=='datasetId,executionId')fail('INVALID_INPUT');
          if(!s.evaluationOptions)fail('EVALUATION_OPTIONS_NOT_CONFIGURED');
          result=await s.evaluationOptions.read({datasetId:id(url.searchParams.get('datasetId')),executionId:id(url.searchParams.get('executionId'))},identity);
        }else if(req.method==='GET'&&(route==='/evaluation-jobs'||route==='/evaluation-jobs/pending')){
          if([...url.searchParams.keys()].join(',')!=='key')fail('INVALID_INPUT');const control=key(url.searchParams.get('key'));
          result=route.endsWith('/pending')?await jobs.discover(control,identity):await jobs.listOwn(control,identity);
        }else{
          if(url.search)fail('INVALID_INPUT');
          if(req.method==='POST'&&route==='/evaluation-jobs/lookup'){
            const v=object(await body(req),['key','requestKey']);result=await jobs.lookup(key(v.key),text(v.requestKey),identity);
          }else if(req.method==='POST'&&route==='/evaluation-jobs'){
            const raw=object(await body(req),['mode','input']);if(raw.mode!=='EVALUATE')fail('INVALID_INPUT');
            const v=object(raw.input,['key','requestKey','protocolId','executionId','validationDatasetIds']);
            const members=ids(v.validationDatasetIds);if(members.length>10)fail('INVALID_MEMBERS');
            result=await jobs.enqueue({mode:'EVALUATE',input:{key:key(v.key),requestKey:text(v.requestKey),protocolId:id(v.protocolId),executionId:id(v.executionId),validationDatasetIds:members}},identity);
          }else if(req.method==='GET'&&evaluationJob&&!evaluationJob[2])result=await jobs.read(evaluationJob[1]!,identity);
          else if(req.method==='POST'&&evaluationJob?.[2]){
            const action=evaluationJob[2],reference=evaluationJob[1]!;
            if(action==='claim'){object(await body(req),[]);result=await jobs.claim(reference,identity);}
            else if(action==='run'||action==='fail'){const v=object(await body(req),['expectedVersion','leaseToken']);
              result=action==='run'?await jobs.run(reference,version(v.expectedVersion),text(v.leaseToken),identity):await jobs.failAttempt(reference,version(v.expectedVersion),text(v.leaseToken),identity);
            }else{const v=object(await body(req),['expectedVersion']);result=action==='cancel'?await jobs.cancel(reference,version(v.expectedVersion),identity):await jobs.reconcileExhausted(reference,version(v.expectedVersion),identity);}
          }else fail('NOT_FOUND');
        }
      }else if(route==='/action-execution-jobs'||actionExecutionJob){
        const jobs=s.actionExecutionJobs,url=new URL(req.url!,'http://127.0.0.1');if(!jobs)fail('ACTION_EXECUTION_JOBS_NOT_CONFIGURED');
        if(req.method==='GET'&&route==='/action-execution-jobs/options'){
          if(url.search)fail('INVALID_INPUT');if(!s.actionExecutionCatalog)fail('ACTION_EXECUTION_CATALOG_NOT_CONFIGURED');result=await s.actionExecutionCatalog.read(identity);
        }else if(req.method==='GET'&&route==='/action-execution-jobs'){
          if([...url.searchParams.keys()].join(',')!=='key')fail('INVALID_INPUT');result=await jobs.listOwn(key(url.searchParams.get('key')),identity);
        }else{
          if(url.search)fail('INVALID_INPUT');
          if(req.method==='POST'&&route==='/action-execution-jobs/lookup'){
            const v=object(await body(req),['key','requestKey']);result=await jobs.lookup(key(v.key),text(v.requestKey),identity);
          }else if(req.method==='POST'&&route==='/action-execution-jobs'){
            const raw=object(await body(req),['mode','input']);if(raw.mode!=='EXECUTE')fail('INVALID_INPUT');
            const v=object(raw.input,['key','requestKey','requestId','expectedVersion']);
            result=await jobs.enqueue({mode:'EXECUTE',input:{key:key(v.key),requestKey:text(v.requestKey),requestId:id(v.requestId),expectedVersion:version(v.expectedVersion)}},identity);
          }else if(req.method==='GET'&&actionExecutionJob&&!actionExecutionJob[2])result=await jobs.read(actionExecutionJob[1]!,identity);
          else if(req.method==='POST'&&actionExecutionJob?.[2]==='cancel'){
            const v=object(await body(req),['expectedVersion']);result=await jobs.cancel(actionExecutionJob[1]!,version(v.expectedVersion),identity);
          }else fail('NOT_FOUND');
        }
      }else if(route==='/decision-jobs'||decisionJob){
        const jobs=s.decisionJobs,url=new URL(req.url!,'http://127.0.0.1');if(!jobs)fail('DECISION_JOBS_NOT_CONFIGURED');
        if(req.method==='GET'&&route==='/decision-jobs/options'){
          if(url.search)fail('INVALID_INPUT');if(!s.modelReview)fail('MODEL_REVIEW_NOT_CONFIGURED');result=await s.modelReview.read(identity);
        }else if(req.method==='GET'&&(route==='/decision-jobs'||route==='/decision-jobs/pending')){
          if([...url.searchParams.keys()].join(',')!=='key')fail('INVALID_INPUT');const control=key(url.searchParams.get('key'));
          result=route.endsWith('/pending')?await jobs.discover(control,identity):await jobs.listOwn(control,identity);
        }else{
          if(url.search)fail('INVALID_INPUT');
          if(req.method==='POST'&&route==='/decision-jobs/lookup'){
            const v=object(await body(req),['key','requestKey']);result=await jobs.lookup(key(v.key),text(v.requestKey),identity);
          }else if(req.method==='POST'&&route==='/decision-jobs'){
            const raw=object(await body(req),['mode','input']);if(raw.mode!=='DECIDE')fail('INVALID_INPUT');
            const v=object(raw.input,['key','requestKey','evaluationId','evaluationVersion','decision','reason']);
            result=await jobs.enqueue({mode:'DECIDE',input:{key:key(v.key),requestKey:text(v.requestKey),evaluationId:id(v.evaluationId),evaluationVersion:version(v.evaluationVersion),decision:decision(v.decision),reason:text(v.reason)}},identity);
          }else if(req.method==='GET'&&decisionJob&&!decisionJob[2])result=await jobs.read(decisionJob[1]!,identity);
          else if(req.method==='POST'&&decisionJob?.[2]){
            const action=decisionJob[2],reference=decisionJob[1]!;
            if(action==='claim'){object(await body(req),[]);result=await jobs.claim(reference,identity);}
            else if(action==='run'||action==='fail'){const v=object(await body(req),['expectedVersion','leaseToken']);
              result=action==='run'?await jobs.run(reference,version(v.expectedVersion),text(v.leaseToken),identity):await jobs.failAttempt(reference,version(v.expectedVersion),text(v.leaseToken),identity);
            }else{const v=object(await body(req),['expectedVersion']);result=action==='cancel'?await jobs.cancel(reference,version(v.expectedVersion),identity):await jobs.reconcileExhausted(reference,version(v.expectedVersion),identity);}
          }else fail('NOT_FOUND');
        }
      }else if(route==='/selection-jobs'||selectionJob){
        const jobs=s.selectionJobs,url=new URL(req.url!,'http://127.0.0.1');if(!jobs)fail('SELECTION_JOBS_NOT_CONFIGURED');
        if(req.method==='GET'&&(route==='/selection-jobs'||route==='/selection-jobs/pending')){
          if([...url.searchParams.keys()].join(',')!=='key')fail('INVALID_INPUT');const control=key(url.searchParams.get('key'));
          result=route.endsWith('/pending')?await jobs.discover(control,identity):await jobs.listOwn(control,identity);
        }else{
          if(url.search)fail('INVALID_INPUT');
          if(req.method==='POST'&&route==='/selection-jobs/lookup'){
            const v=object(await body(req),['key','requestKey']);result=await jobs.lookup(key(v.key),text(v.requestKey),identity);
          }else if(req.method==='POST'&&route==='/selection-jobs'){
            const raw=object(await body(req),['mode','input']);if(raw.mode!=='ACTIVATE'&&raw.mode!=='ROLLBACK')fail('INVALID_INPUT');
            const v=object(raw.input,['key','expectedVersion','requestKey','reason',raw.mode==='ACTIVATE'?'decisionId':'revisionId']);
            if(!Number.isSafeInteger(v.expectedVersion)||Number(v.expectedVersion)<0)fail('INVALID_VERSION');
            const common={key:key(v.key),expectedVersion:Number(v.expectedVersion),requestKey:text(v.requestKey),reason:text(v.reason)};
            result=await jobs.enqueue(raw.mode==='ACTIVATE'?{mode:'ACTIVATE',input:{...common,decisionId:id(v.decisionId)}}:{mode:'ROLLBACK',input:{...common,revisionId:id(v.revisionId)}},identity);
          }else if(req.method==='GET'&&selectionJob&&!selectionJob[2])result=await jobs.read(selectionJob[1]!,identity);
          else if(req.method==='POST'&&selectionJob?.[2]){
            const action=selectionJob[2],reference=selectionJob[1]!;
            if(action==='claim'){object(await body(req),[]);result=await jobs.claim(reference,identity);}
            else if(action==='run'||action==='fail'){const v=object(await body(req),['expectedVersion','leaseToken']);
              result=action==='run'?await jobs.run(reference,version(v.expectedVersion),text(v.leaseToken),identity):await jobs.failAttempt(reference,version(v.expectedVersion),text(v.leaseToken),identity);
            }else{const v=object(await body(req),['expectedVersion']);result=action==='cancel'?await jobs.cancel(reference,version(v.expectedVersion),identity):await jobs.reconcileExhausted(reference,version(v.expectedVersion),identity);}
          }else fail('NOT_FOUND');
        }
      }else if(route==='/belief-jobs'||beliefJob){
        const jobs=s.beliefJobs;if(!jobs)fail('BELIEF_JOBS_NOT_CONFIGURED');
        if(route==='/belief-jobs/lookup'){
          if(req.method!=='POST')fail('NOT_FOUND');if((req.url??'').includes('?'))fail('INVALID_INPUT');
          if(!jobs.lookup)fail('BELIEF_JOB_LOOKUP_NOT_CONFIGURED');
          const v=object(await body(req),['key','episodeId','authorizationId','snapshotId']);
          result=await jobs.lookup({key:key(v.key),episodeId:id(v.episodeId),authorizationId:id(v.authorizationId),snapshotId:id(v.snapshotId)},identity);
        }else if(route==='/belief-jobs'&&req.method==='GET')result=await jobs.discover(identity);
        else if(route==='/belief-jobs'&&req.method==='POST'){
          const v=object(await body(req),['authorizationId','snapshotId','expectedVersion']);
          if(!Number.isSafeInteger(v.expectedVersion)||Number(v.expectedVersion)<0)fail('INVALID_VERSION');
          result=await jobs.enqueue({authorizationId:id(v.authorizationId),snapshotId:id(v.snapshotId),expectedVersion:Number(v.expectedVersion)},identity);
        }else if(req.method==='GET'&&beliefJob&&!beliefJob[2])result=await jobs.read(beliefJob[1]!,identity);
        else if(req.method==='POST'&&beliefJob?.[2]){
          const action=beliefJob[2],reference=beliefJob[1]!;
          if(action==='claim'){object(await body(req),[]);result=await jobs.claim(reference,identity);}
          else if(action==='run'||action==='fail'){const v=object(await body(req),['expectedVersion','leaseToken']);
            result=action==='run'?await jobs.run(reference,version(v.expectedVersion),text(v.leaseToken),identity):await jobs.failAttempt(reference,version(v.expectedVersion),text(v.leaseToken),identity);
          }else{const v=object(await body(req),['expectedVersion']);result=action==='cancel'?await jobs.cancel(reference,version(v.expectedVersion),identity):await jobs.reconcileExhausted(reference,version(v.expectedVersion),identity);}
        }else fail('NOT_FOUND');
      }else if(route==='/beliefs/replay'||currentBelief){
        const registry=s.beliefs;if(!registry)fail('BELIEF_RUNTIME_NOT_CONFIGURED');
        if(req.method==='POST'&&route==='/beliefs/replay'){
          const v=object(await body(req),['authorizationId','snapshotId','expectedVersion']);
          if(!Number.isSafeInteger(v.expectedVersion)||Number(v.expectedVersion)<0)fail('INVALID_VERSION');
          result=await registry.replay({authorizationId:id(v.authorizationId),snapshotId:id(v.snapshotId),expectedVersion:Number(v.expectedVersion)},identity);
        }else if(req.method==='GET'&&currentBelief)result=await registry.readCurrent(currentBelief[1]!,currentBelief[2]!,identity);
        else fail('NOT_FOUND');
      }else if(beliefPosition){
        if(req.method!=='GET')fail('NOT_FOUND');
        if((req.url??'').includes('?'))fail('INVALID_INPUT');
        if(!s.beliefs?.replayPosition)fail('BELIEF_RUNTIME_NOT_CONFIGURED');
        // Native head metadata is recoverable even when current prediction is
        // stale. It requires belief:replay access and never grants model usage.
        const position=await s.beliefs.replayPosition(beliefPosition[1]!,beliefPosition[2]!,identity);
        result={...position,readOnly:true,qualification:'NOT_CHECKED',predictionReady:false,replayAuthorized:false};
      }else if(route==='/replay-authorizations'||replayAuthorization){
        const registry=s.replayAuthorizations;if(!registry)fail('REPLAY_AUTHORIZATION_NOT_CONFIGURED');
        if(req.method==='GET'&&route==='/replay-authorizations'){
          const query=new URL(req.url!,'http://127.0.0.1').searchParams;
          if([...query.keys()].sort().join(',')!=='key')fail('INVALID_INPUT');
          if(!registry.listForSelection)fail('REPLAY_AUTHORIZATION_DISCOVERY_NOT_CONFIGURED');
          result=await registry.listForSelection(key(query.get('key')),identity);
        }else if(req.method==='POST'&&route==='/replay-authorizations'){
          const v=object(await body(req),['key','expectedDeploymentVersion','reason']);
          result=await registry.approve({key:key(v.key),expectedDeploymentVersion:version(v.expectedDeploymentVersion),reason:text(v.reason)},identity);
        }else if(req.method==='GET'&&replayAuthorization&&!replayAuthorization[2])result=await registry.read(replayAuthorization[1]!,identity);
        else if(req.method==='POST'&&replayAuthorization?.[2]==='revoke'){
          const v=object(await body(req),['expectedVersion','reason']);result=await registry.revoke(replayAuthorization[1]!,version(v.expectedVersion),text(v.reason),identity);
        }else fail('NOT_FOUND');
      }else if(route==='/model-evaluations'||modelEvaluation){
        const registry=s.modelEvaluations;if(!registry)fail('MODEL_EVALUATION_NOT_CONFIGURED');
        if(req.method==='POST'&&route==='/model-evaluations'){
          const v=object(await body(req),['protocolId','executionId','validationDatasetIds']);
          result=await registry.evaluate({protocolId:id(v.protocolId),executionId:id(v.executionId),validationDatasetIds:ids(v.validationDatasetIds)},identity);
        }else if(req.method==='GET'&&modelEvaluation)result=await registry.read(modelEvaluation[1]!,identity);
        else fail('NOT_FOUND');
      }else if(route==='/model-decisions'||modelDecision){
        const registry=s.modelDecisions;if(!registry)fail('MODEL_DECISION_NOT_CONFIGURED');
        if(req.method==='GET'&&route==='/model-decisions'){
          const url=new URL(req.url!,'http://127.0.0.1');if([...url.searchParams.keys()].join(',')!=='key')fail('INVALID_INPUT');
          result=await registry.listForSelection(key(url.searchParams.get('key')),identity);
        }else if(req.method==='POST'&&route==='/model-decisions'){
          const v=object(await body(req),['key','evaluationId','evaluationVersion','decision','reason']);
          result=await registry.decide({key:key(v.key),evaluationId:id(v.evaluationId),evaluationVersion:version(v.evaluationVersion),decision:decision(v.decision),reason:text(v.reason)},identity);
        }else if(req.method==='GET'&&modelDecision&&!modelDecision[2])result=await registry.read(modelDecision[1]!,identity);
        else if(req.method==='POST'&&modelDecision?.[2]==='revoke'){
          const v=object(await body(req),['expectedVersion','reason']);result=await registry.revoke(modelDecision[1]!,version(v.expectedVersion),text(v.reason),identity);
        }else fail('NOT_FOUND');
      }else if(route==='/deployments'){
        if(req.method!=='GET')fail('NOT_FOUND');
        if((req.url??'').includes('?'))fail('INVALID_INPUT');
        if(!s.modelDeployments?.listAvailable)fail('MODEL_DEPLOYMENT_DISCOVERY_NOT_CONFIGURED');
        result=await s.modelDeployments.listAvailable(identity);
      }else if(modelRevision){
        if(req.method!=='GET')fail('NOT_FOUND');if((req.url??'').includes('?'))fail('INVALID_INPUT');
        const registry=s.modelDeployments;if(!registry?.listRevisions||!registry.readRevision)fail('MODEL_DEPLOYMENT_HISTORY_NOT_CONFIGURED');
        result=modelRevision[2]?await registry.readRevision(modelRevision[1]!,modelRevision[2],identity):await registry.listRevisions(modelRevision[1]!,identity);
      }else if(modelDeployment){
        const registry=s.modelDeployments;if(!registry)fail('MODEL_DEPLOYMENT_NOT_CONFIGURED');
        if(req.method==='POST'&&['activate','rollback'].includes(modelDeployment[1]!)){
          const rollback=modelDeployment[1]==='rollback',v=object(await body(req),['key','expectedVersion',rollback?'revisionId':'decisionId','requestKey','reason']);
          if(!Number.isSafeInteger(v.expectedVersion)||Number(v.expectedVersion)<(rollback?1:0))fail('INVALID_VERSION');
          const common={key:key(v.key),expectedVersion:Number(v.expectedVersion),requestKey:text(v.requestKey),reason:text(v.reason)};
          result=rollback?await registry.rollback({...common,revisionId:id(v.revisionId)},identity):await registry.activate({...common,decisionId:id(v.decisionId)},identity);
        }else if(req.method==='GET')result=await registry.read(modelDeployment[1]!,identity);
        else fail('NOT_FOUND');
      }else if(route==='/evaluation-protocols'||evaluationProtocol){
        const registry=s.evaluationProtocols;if(!registry)fail('EVALUATION_PROTOCOL_NOT_CONFIGURED');
        if(req.method==='POST'&&route==='/evaluation-protocols'){
          const v=object(await body(req),['key','revision','recipeHash','cohortIds','evaluatorId','configuration']);
          if(typeof v.recipeHash!=='string'||!/^[a-f0-9]{64}$/.test(v.recipeHash)||!v.configuration||typeof v.configuration!=='object'||Array.isArray(v.configuration))fail('INVALID_INPUT');
          result=await registry.propose({key:key(v.key),revision:version(v.revision),recipeHash:v.recipeHash,cohortIds:ids(v.cohortIds),evaluatorId:key(v.evaluatorId),configuration:v.configuration as Record<string,unknown>},identity);
        }else if(req.method==='GET'&&evaluationProtocol&&!evaluationProtocol[2])result=await registry.read(evaluationProtocol[1]!,identity);
        else if(req.method==='POST'&&evaluationProtocol?.[2]){
          const v=object(await body(req),evaluationProtocol[2]==='review'?['expectedVersion','decision','reason']:['expectedVersion','reason']);
          result=evaluationProtocol[2]==='review'?await registry.review(evaluationProtocol[1]!,version(v.expectedVersion),decision(v.decision),text(v.reason),identity)
            :await registry.revoke(evaluationProtocol[1]!,version(v.expectedVersion),text(v.reason),identity);
        }else fail('NOT_FOUND');
      }else if(req.method==='POST'&&route==='/partitions'){const v=object(await body(req),['snapshotId']);result=await s.partitions.reserve(id(v.snapshotId),identity);}
      else if(req.method==='GET'&&route==='/feedback-options'){
        if(!s.feedback.proposalOptions)fail('FEEDBACK_OPTIONS_NOT_CONFIGURED');const query=new URL(req.url!,'http://127.0.0.1').searchParams;
        if([...query.keys()].sort().join(',')!=='rootId,rootType')fail('INVALID_INPUT');
        result=await s.feedback.proposalOptions({type:id(query.get('rootType')),id:id(query.get('rootId'))},identity);
      }
      else if(req.method==='POST'&&route==='/feedback-preview'){
        if(!s.feedback.preview)fail('FEEDBACK_PREVIEW_NOT_CONFIGURED');const v=object(await body(req),['inputSnapshotId','labelSnapshotId','eventId']);
        result=await s.feedback.preview({inputSnapshotId:id(v.inputSnapshotId),labelSnapshotId:id(v.labelSnapshotId),eventId:id(v.eventId)},identity);
      }
      else if(req.method==='GET'&&route==='/cohort-options'){
        const query=new URL(req.url!,'http://127.0.0.1').searchParams;
        if([...query.keys()].sort().join(',')!=='rootId,rootType')fail('INVALID_INPUT');
        if(!s.datasets.proposalOptions)fail('DATASET_DISCOVERY_NOT_CONFIGURED');
        result=await s.datasets.proposalOptions({type:id(query.get('rootType')),id:id(query.get('rootId'))},identity);
      }
      else if(req.method==='GET'&&route==='/datasets'){
        if(!s.datasets.frozenForRoot)fail('DATASET_DISCOVERY_NOT_CONFIGURED');
        const query=new URL(req.url!,'http://127.0.0.1').searchParams;
        if([...query.keys()].sort().join(',')!=='rootId,rootType')fail('INVALID_INPUT');
        result=await s.datasets.frozenForRoot({type:id(query.get('rootType')),id:id(query.get('rootId'))},identity);
      }
      else if(req.method==='GET'&&route==='/cohorts'){
        if(!s.datasets.listForRoot)fail('DATASET_DISCOVERY_NOT_CONFIGURED');
        const query=new URL(req.url!,'http://127.0.0.1').searchParams;
        if([...query.keys()].sort().join(',')!=='rootId,rootType')fail('INVALID_INPUT');
        result=await s.datasets.listForRoot({type:id(query.get('rootType')),id:id(query.get('rootId'))},identity);
      }
      else if(req.method==='GET'&&route==='/feedback'){
        if(!s.feedback.listForRoot)fail('FEEDBACK_DISCOVERY_NOT_CONFIGURED');
        const query=new URL(req.url!,'http://127.0.0.1').searchParams;
        if([...query.keys()].sort().join(',')!=='rootId,rootType')fail('INVALID_INPUT');
        result=await s.feedback.listForRoot({type:id(query.get('rootType')),id:id(query.get('rootId'))},identity);
      }
      else if(req.method==='POST'&&route==='/feedback'){const v=object(await body(req),['inputSnapshotId','labelSnapshotId','eventId']);result=await s.feedback.propose({inputSnapshotId:id(v.inputSnapshotId),labelSnapshotId:id(v.labelSnapshotId),eventId:id(v.eventId)},identity);}
      else if(req.method==='POST'&&route==='/cohorts'){const v=object(await body(req),['protocolKey','inputSnapshotIds']);result=await s.datasets.proposeCohort(key(v.protocolKey),ids(v.inputSnapshotIds),identity);}
      else if(req.method==='POST'&&route==='/recipes'){
        const v=object(await body(req),['key','revision','definitionKey','payload']);if(!v.payload||typeof v.payload!=='object'||Array.isArray(v.payload))fail('INVALID_INPUT');
        result=await s.recipes.propose({key:key(v.key),revision:version(v.revision),definitionKey:key(v.definitionKey),payload:v.payload as Record<string,unknown>},identity);
      }else if(req.method==='GET'&&recipe)result=recipe[2]?await s.recipes.readRevision(recipe[1]!,recipe[2],identity):await s.recipes.listRevisions(recipe[1]!,identity);
      else if(req.method==='POST'&&recipeAction){
        const v=object(await body(req),recipeAction[2]==='review'?['expectedVersion','decision','reason']:['expectedVersion','reason']);
        result=recipeAction[2]==='review'?await s.recipes.review(recipeAction[1]!,version(v.expectedVersion),decision(v.decision),text(v.reason),identity):await s.recipes.revoke(recipeAction[1]!,version(v.expectedVersion),text(v.reason),identity);
      }else if(record){
        const [,type,reference,operation]=record;
        if(req.method==='GET'&&!operation)result=type==='partitions'?await s.partitions.read(reference!,identity):type==='feedback'?await s.feedback.read(reference!,identity):type==='cohorts'?await s.datasets.readCohort(reference!,identity):await s.datasets.inspect(reference!,identity);
        else if(req.method==='POST'&&operation==='review'&&['feedback','cohorts'].includes(type!)){
          const v=object(await body(req),['expectedVersion','decision','reason']);result=type==='feedback'?await s.feedback.review(reference!,version(v.expectedVersion),decision(v.decision),text(v.reason),identity):await s.datasets.reviewCohort(reference!,version(v.expectedVersion),decision(v.decision),text(v.reason),identity);
        }else if(req.method==='POST'&&type==='cohorts'&&operation==='freeze'){object(await body(req),[]);result=await s.datasets.freeze(reference!,identity);}
        else fail('NOT_FOUND');
      }else fail('NOT_FOUND');
      await reauthenticate();if(!res.destroyed)send(res,200,{data:result,traceId});
    }catch(error){
      let exposed=publicError(error);
      if(principal&&req.method==='POST')try{await config.recordFailure({id:'audit_'+randomUUID(),tenantId:principal.tenantId,timestamp:new Date().toISOString() as DateTime,traceId,
        actor:{id:principal.id,type:'user',roles:[...principal.roles]},operation:{type:'action',actionType:'PlusLearningRequest'},detail:{result:exposed.status===401||exposed.status===403?'denied':'error',denialReason:exposed.code}});}catch{exposed={status:503,code:'AUDIT_UNAVAILABLE'};}
      if(!res.destroyed)send(res,exposed.status,{error:{code:exposed.code},traceId});
    }finally{req.off('aborted',onAborted);res.off('close',onClosed);}
    return true;
  };
}

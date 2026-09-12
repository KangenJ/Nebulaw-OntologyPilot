// Opt-in isolated control plane. Never installs packs, repairs schema or changes the legacy entrypoint.
import { createServer } from 'node:http';
import { readFileSync,existsSync,statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createNativeStorage } from '../../platform/apps/lwm-demo/src/native-storage.mjs';
import { createPrivateIdentityProvider } from './private-identity.mjs';
import { createPrivateObjectReader } from './object-read-services.mjs';
import { createPrivateGovernanceView } from './governance-view-services.mjs';
import { createPrivateActionIntervalAccess } from './action-interval-services.mjs';
import { NativeOntologyCatalog,ActionOutboxWorker,createPlusControlHandler,createPlusComputeHandler,createPlusLearningHandler } from '../../platform/packages/plus-runtime/dist/index.js';
import { CelClient } from '../../platform/packages/actions/dist/index.js';
import { createTaskDomain } from '../../platform/apps/lwm-demo/src/task-domain.mjs';
import { createMatterIntakeDomain } from '../../platform/apps/lwm-demo/src/matter-intake.mjs';
import { createRuleIntakeDomain } from '../../platform/apps/lwm-demo/src/rule-intake.mjs';
import { createTaskPriorityDomain } from '../../platform/apps/lwm-demo/src/task-priority.mjs';
import { createTaskDomainAccess } from '../../platform/apps/lwm-demo/src/task-access.mjs';
import { createTaskEpisodeRuntime } from '../../platform/apps/lwm-demo/src/task-episode.mjs';
import { createPrivateTaskServices } from './task-services.mjs';
import { createPrivateComputeAccess } from './compute-access.mjs';
import { createPrivateComputeAuthorizationAccess } from './compute-authorization-services.mjs';
import { createNativeRecipeSelectionResolver } from './native-recipe-selection.mjs';
import { createNativeBeliefEventSink } from './belief-event-sink.mjs';
import { createBeliefRefreshInitializer } from './belief-refresh-initializer.mjs';
import { createPrivateNativeFitVerifiers as createRegisteredNativeFitVerifiers } from '../../services/plus-engine/private-fit-registry.mjs';
import { createPrivateFitRegistration } from './fit-qualification.mjs';
import { createModelSelectionWorker } from './model-selection-worker.mjs';
import { createModelEvaluationWorker } from './model-evaluation-worker.mjs';
import { createModelDecisionWorker } from './model-decision-worker.mjs';
import { createActionExecutionWorker } from './action-execution-worker.mjs';
import { createPrivateActionExecutionJobAccess } from './action-execution-job-services.mjs';
import { createNativeBackgroundSequence } from './native-background-sequence.mjs';
import { createNativeAuditGate,isNativeComputeMetadataRequest } from './native-audit-gate.mjs';
import { createPrivatePolicyLoader } from './private-policy-loader.mjs';

const ROLES=['viewer','investigator','data_reviewer','trainer','model_owner','case_reviewer'];
const error=code=>Object.assign(new Error(code),{code});
function validatePolicy(value){
  if(value.version!==1||!value.definitions||typeof value.definitions!=='object'||Array.isArray(value.definitions))throw error('INVALID_POLICY_CONFIGURATION');
  for(const [key,entry]of Object.entries(value.definitions)){
    if(!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(key)||!entry||!entry.policy)throw error('INVALID_POLICY_CONFIGURATION');
    for(const name of ['readRoles','draftRoles','publishRoles'])if(!Array.isArray(entry[name])||entry[name].some(role=>!ROLES.includes(role)))throw error('INVALID_POLICY_CONFIGURATION');
  }
  return value;
}
export async function startPlusControlServer({dbPath,authPath,policyPath,tenantId,port=0,workerIntervalMs=1000,selectionWorkerIntervalMs=0,evaluationWorkerIntervalMs=0,decisionWorkerIntervalMs=0,actionExecutionWorkerIntervalMs=0,deferBackgroundWorkers=false,celAddress,syntheticCompleteFitQualification,reviewedCompleteFit}){
  if(typeof deferBackgroundWorkers!=='boolean')throw error('INVALID_BACKGROUND_WORKER_START_MODE');
  for(const path of [dbPath,authPath,policyPath])if(typeof path!=='string'||!existsSync(path)||!statSync(path).isFile())throw error('EXISTING_PRIVATE_CONFIGURATION_REQUIRED');
  if(!tenantId||typeof tenantId!=='string'||!Number.isInteger(port)||port<0||port>65535||!Number.isInteger(workerIntervalMs)||workerIntervalMs<0||(workerIntervalMs>0&&workerIntervalMs<100))throw error('INVALID_SERVER_CONFIGURATION');
  if(!Number.isInteger(selectionWorkerIntervalMs)||selectionWorkerIntervalMs<0||selectionWorkerIntervalMs>60000||(selectionWorkerIntervalMs>0&&selectionWorkerIntervalMs<100))throw error('INVALID_SELECTION_WORKER_INTERVAL');
  if(!Number.isInteger(evaluationWorkerIntervalMs)||evaluationWorkerIntervalMs<0||evaluationWorkerIntervalMs>60000||(evaluationWorkerIntervalMs>0&&evaluationWorkerIntervalMs<100))throw error('INVALID_EVALUATION_WORKER_INTERVAL');
  if(!Number.isInteger(decisionWorkerIntervalMs)||decisionWorkerIntervalMs<0||decisionWorkerIntervalMs>60000||(decisionWorkerIntervalMs>0&&decisionWorkerIntervalMs<100))throw error('INVALID_DECISION_WORKER_INTERVAL');
  if(!Number.isInteger(actionExecutionWorkerIntervalMs)||actionExecutionWorkerIntervalMs<0||actionExecutionWorkerIntervalMs>60000||(actionExecutionWorkerIntervalMs>0&&actionExecutionWorkerIntervalMs<100))throw error('INVALID_ACTION_EXECUTION_WORKER_INTERVAL');
  // The synthetic seam stays constructor-only. Normal managed v2 deployment
  // supplies a separate exact private reference, never an HTTP/policy flag.
  const qualification=syntheticCompleteFitQualification===undefined?undefined:structuredClone(syntheticCompleteFitQualification);
  const reviewed=reviewedCompleteFit===undefined?undefined:structuredClone(reviewedCompleteFit);
  const readPolicy=createPrivatePolicyLoader(policyPath);
  const registration=createPrivateFitRegistration({tenantId,loadPolicy:()=>validatePolicy(readPolicy()),syntheticCompleteFitQualification:qualification,reviewedCompleteFit:reviewed});
  const load=registration.loadPolicy;load();
  const identities=createPrivateIdentityProvider({authPath,tenantId});identities.assertConfigured();
  if(load().computeAuthorizations!==undefined)createPrivateComputeAuthorizationAccess({tenantId,identities,loadPolicy:load,engineIds:registration.engineIds}).assertConfigured();
  createPrivateGovernanceView({tenantId,identities,loadPolicy:load}).assertConfigured();
  if(load().actionExecutionJobs!==undefined)createPrivateActionExecutionJobAccess({tenantId,identities,loadPolicy:load}).assertConfigured();
  if(load().actionIntervals!==undefined)createPrivateActionIntervalAccess({tenantId,identities,loadPolicy:load}).assertConfigured();
  if(celAddress!==undefined&&!/^127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(celAddress))throw error('INVALID_CEL_ADDRESS');
  const cel=celAddress?new CelClient({address:celAddress,maxRetries:0,timeoutMs:2000}):undefined;
  const storage=createNativeStorage(dbPath);
  const system={id:'plus-control-audit-worker',tenantId,roles:[]};
  // The private identity only verifies the catalog and delivers committed audit envelopes.
  const catalog=new NativeOntologyCatalog({storage,tenantId,authorize:async(p,permission)=>p.id===system.id&&permission==='ontology:read'});
  let current;
  try{current=await catalog.read(system);}catch(e){cel?.close();storage.close();throw e;}
  if(registration.reviewedOntologyHash!==undefined&&registration.reviewedOntologyHash!==current.bundle.contentHash){cel?.close();storage.close();throw error('REVIEWED_FIT_ONTOLOGY_MISMATCH');}
  const evaluationPolicy=load().evaluation;
  if(load().computeAuthorizations?.enabled===true){
    if(load().taskLearning?.enabled!==true){cel?.close();storage.close();throw error('COMPUTE_AUTHORIZATION_NATIVE_LEARNING_REQUIRED');}
    const schema=current.bundle.parsed,expected=[['PlusComputeAuthorizationDataset','PlusComputeAuthorization','PlusDatasetRevision','MANY_TO_MANY'],
      ['PlusComputeAuthorizationRecipe','PlusComputeAuthorization','PlusModelRecipe','MANY_TO_ONE'],
      ['PlusExecutionComputeAuthorization','PlusExecution','PlusComputeAuthorization','MANY_TO_ONE'],
      ['PlusReleaseComputeAuthorization','PlusModelRelease','PlusComputeAuthorization','MANY_TO_ONE']];
    if(!schema.objectTypes.some(t=>t.name==='PlusComputeAuthorization')||expected.some(([name,from,to,cardinality])=>
      !schema.linkTypes.some(l=>l.name===name&&l.from===from&&l.to===to&&l.cardinality===cardinality))){
      cel?.close();storage.close();throw error('COMPUTE_AUTHORIZATION_SCHEMA_NOT_CONFIGURED');
    }
  }
  if(load().actionExecutionJobs?.enabled===true){
    if(load().actionRequests?.enabled!==true){cel?.close();storage.close();throw error('ACTION_EXECUTION_JOB_NATIVE_ACTION_REQUIRED');}
    if([['PlusExecutionActionRequest','PlusActionRequest'],['PlusExecutionActionDecision','PlusActionDecision'],['PlusExecutionActionResult','PlusActionRequest']].some(([name,to])=>
      !current.bundle.parsed.linkTypes.some(l=>l.name===name&&l.from==='PlusExecution'&&l.to===to&&l.cardinality==='MANY_TO_ONE'))){
      cel?.close();storage.close();throw error('ACTION_EXECUTION_JOB_SCHEMA_NOT_CONFIGURED');
    }
  }
  if(load().decisionJobs?.enabled===true){
    if(load().modelGovernance?.enabled!==true||evaluationPolicy?.enabled!==true){cel?.close();storage.close();throw error('DECISION_JOB_NATIVE_DECISION_REQUIRED');}
    if([['PlusExecutionDecisionEvaluation','PlusModelEvaluation'],['PlusExecutionDecisionResult','PlusModelDecision']].some(([name,to])=>
      !current.bundle.parsed.linkTypes.some(l=>l.name===name&&l.from==='PlusExecution'&&l.to===to&&l.cardinality==='MANY_TO_ONE'))){
      cel?.close();storage.close();throw error('DECISION_JOB_SCHEMA_NOT_CONFIGURED');
    }
  }
  if(load().evaluationJobs?.enabled===true&&evaluationPolicy?.enabled!==true){
    cel?.close();storage.close();throw error('EVALUATION_JOB_NATIVE_EVALUATION_REQUIRED');
  }
  if(load().selectionJobs?.enabled===true){
    if([['PlusExecutionSelectionDecision','PlusModelDecision'],['PlusExecutionSelectionResult','PlusDeploymentRevision']].some(([name,to])=>
      !current.bundle.parsed.linkTypes.some(l=>l.name===name&&l.from==='PlusExecution'&&l.to===to&&l.cardinality==='MANY_TO_ONE'))){
      cel?.close();storage.close();throw error('SELECTION_JOB_SCHEMA_NOT_CONFIGURED');
    }
  }
  if(load().evaluationJobs?.enabled===true){
    if([['PlusExecutionEvaluationProtocol','PlusEvaluationProtocol'],['PlusExecutionEvaluationFit','PlusExecution'],['PlusExecutionEvaluationResult','PlusModelEvaluation']].some(([name,to])=>
      !current.bundle.parsed.linkTypes.some(l=>l.name===name&&l.from==='PlusExecution'&&l.to===to&&l.cardinality==='MANY_TO_ONE'))){
      cel?.close();storage.close();throw error('EVALUATION_JOB_SCHEMA_NOT_CONFIGURED');
    }
  }
  if(load().compositionReplay?.enabled===true){
    if(!current.bundle.parsed.linkTypes.some(l=>l.name==='PlusBeliefRuleSpecification'&&l.from==='PlusBeliefSnapshot'&&l.to==='PlusRuleSpecification'&&l.cardinality==='MANY_TO_ONE')){
      cel?.close();storage.close();throw error('BELIEF_COMPOSITION_SCHEMA_NOT_CONFIGURED');
    }
    if(load().beliefRuntime?.enabled!==true||load().taskRules?.enabled!==true||!celAddress){cel?.close();storage.close();throw error('BELIEF_COMPOSITION_DEPENDENCY_CONFIGURATION_REQUIRED');}
  }
  if(load().taskLearning?.recipes?.some(e=>e?.policy?.engineIds?.includes('ontology-composed-observation-v1'))){
    if(!current.bundle.parsed.linkTypes.some(l=>l.name==='PlusRecipeRuleSpecification'&&l.from==='PlusModelRecipe'&&l.to==='PlusRuleSpecification'&&l.cardinality==='MANY_TO_MANY')){
      cel?.close();storage.close();throw error('COMPOSITION_RECIPE_SCHEMA_NOT_CONFIGURED');
    }
    if(load().taskRules?.enabled!==true){cel?.close();storage.close();throw error('COMPOSITION_RECIPE_QUALIFIER_REQUIRED');}
  }
  if(load().taskRules?.enabled===true){
    if(!current.bundle.parsed.linkTypes.some(l=>l.name==='TaskRuleSpecificationSource'&&l.from==='PlusRuleSpecification'&&l.to==='RuleVersion'&&l.cardinality==='MANY_TO_MANY')){
      cel?.close();storage.close();throw error('TASK_RULE_SCHEMA_NOT_CONFIGURED');
    }
  }
  if(evaluationPolicy?.enabled===true&&Array.isArray(evaluationPolicy.protocols)&&evaluationPolicy.protocols.some(e=>e?.purpose?.reference)){
    const expected=[['Deployment','PlusDeployment'],['Selection','PlusDeploymentRevision'],['Decision','PlusModelDecision'],['Release','PlusModelRelease'],
      ['Definition','PlusDefinitionRevision'],['Recipe','PlusModelRecipe'],['Execution','PlusExecution'],['Training','PlusDatasetRevision']];
    if(expected.some(([suffix,to])=>!current.bundle.parsed.linkTypes.some(l=>l.name==='PlusEvaluationReference'+suffix&&l.from==='PlusEvaluationProtocol'
      &&l.to===to&&l.cardinality===(suffix==='Training'?'MANY_TO_MANY':'MANY_TO_ONE')))){
      cel?.close();storage.close();throw error('EVALUATION_REFERENCE_SCHEMA_NOT_CONFIGURED');
    }
  }
  if(load().actionRequests?.enabled===true){
    const schema=current.bundle.parsed,decision=schema.objectTypes.find(t=>t.name==='PlusActionDecision');
    const expected=[['PlusRequestScenario','PlusScenarioRun','MANY_TO_ONE'],['PlusRequestDecision','PlusActionDecision','ONE_TO_MANY']];
    if(!decision||!['inputVersion','contentHash'].every(name=>decision.fields.some(f=>f.name===name))
      ||expected.some(([name,to,cardinality])=>!schema.linkTypes.some(l=>l.name===name&&l.from==='PlusActionRequest'&&l.to===to&&l.cardinality===cardinality))){
      cel?.close();storage.close();throw error('ACTION_REQUEST_SCHEMA_NOT_CONFIGURED');
    }
  }
  if(load().scenarioPlanning?.enabled===true){
    const expected=[['PlusScenarioBelief','PlusBeliefSnapshot'],['PlusScenarioDefinition','PlusDefinitionRevision'],['PlusScenarioRelease','PlusModelRelease'],['PlusScenarioSelection','PlusDeploymentRevision']];
    if(expected.some(([name,to])=>!current.bundle.parsed.linkTypes.some(l=>l.name===name&&l.from==='PlusScenarioRun'&&l.to===to&&l.cardinality==='MANY_TO_ONE'))){
      cel?.close();storage.close();throw error('SCENARIO_SCHEMA_NOT_CONFIGURED');
    }
  }
  const ontologyRoles={ 'ontology:read':ROLES, 'ontology:draft':['data_reviewer'], 'ontology:validate':['data_reviewer'], 'ontology:publish':['model_owner'] };
  // Optional private FIT assembly. Merely enabling a flag does not approve any
  // data/recipe, install a schema, start a worker or make a model prediction-ready.
  let computeHandler,learningHandler,refreshSink,refreshInitializer,selectionWorker,evaluationWorker,decisionWorker,actionExecutionWorker;
  try{
    if(load().selectionJobs?.enabled===true||load().actionIntervals?.enabled===true||load().compute?.enabled===true||load().taskLearning?.enabled===true||load().evaluation?.enabled===true||load().modelGovernance?.enabled===true||load().replayGovernance?.enabled===true||load().beliefRuntime?.enabled===true||load().beliefJobs?.enabled===true||load().beliefRefresh?.enabled===true||load().scenarioPlanning?.enabled===true||load().actionRequests?.enabled===true||load().taskRules?.enabled===true){
      const servicesFor=reauthenticate=>createPrivateTaskServices({storage,tenantId,identities,loadPolicy:load,cel,celAddress,reauthenticate,syntheticCompleteFitQualification:qualification,reviewedCompleteFit:reviewed});
      const learning=servicesFor();learning.assertConfigured();
      if(selectionWorkerIntervalMs){
        if(load().selectionJobs?.enabled!==true)throw error('SELECTION_WORKER_OPT_IN_REQUIRED');
        selectionWorker=createModelSelectionWorker({tenantId,identities,loadPolicy:load,servicesFor});selectionWorker.assertConfigured();
      }
      if(evaluationWorkerIntervalMs){
        if(load().evaluationJobs?.enabled!==true)throw error('EVALUATION_WORKER_OPT_IN_REQUIRED');
        evaluationWorker=createModelEvaluationWorker({tenantId,identities,loadPolicy:load,servicesFor});evaluationWorker.assertConfigured();
      }
      if(decisionWorkerIntervalMs){
        if(load().decisionJobs?.enabled!==true)throw error('DECISION_WORKER_OPT_IN_REQUIRED');
        decisionWorker=createModelDecisionWorker({tenantId,identities,loadPolicy:load,servicesFor});decisionWorker.assertConfigured();
      }
      if(actionExecutionWorkerIntervalMs){
        if(load().actionExecutionJobs?.enabled!==true)throw error('ACTION_EXECUTION_WORKER_OPT_IN_REQUIRED');
        actionExecutionWorker=createActionExecutionWorker({tenantId,identities,loadPolicy:load,servicesFor});actionExecutionWorker.assertConfigured();
      }
      if(load().beliefRefresh?.enabled===true){refreshSink=createNativeBeliefEventSink({storage,tenantId,identities,loadPolicy:load,servicesFor});refreshSink.assertConfigured();
        refreshInitializer=createBeliefRefreshInitializer({sink:refreshSink,identities,loadPolicy:load});}
      learningHandler=createPlusLearningHandler({tenantId,authenticate:identities.authenticate,createServices:({reauthenticate})=>servicesFor(reauthenticate),
        allowedOrigins:load().learningOrigins??[],recordFailure:record=>storage.auditStore.appendIdempotent(record)});
      if(load().compute?.enabled===true){
      let admission=learning.computeConfiguration;
      if(!admission){
      const recipeSelections=load().compute?.jobs?.some(j=>j?.policy?.recipeSelection)?createNativeRecipeSelectionResolver({storage,tenantId,identities,loadPolicy:load,recipes:learning.recipes}):undefined;
      const access=createPrivateComputeAccess({tenantId,identities,loadPolicy:load,engineIds:registration.engineIds,recipeSelections});access.assertConfigured();
      // Full evaluation/governance hosts reuse the SAME material/component/
      // compute graph. FIT-only legacy hosts retain their original assembly.
      admission={storage,tenantId,datasets:learning.datasets,recipes:learning.recipes,transitionPlans:learning.transitionPlans,...access,...createRegisteredNativeFitVerifiers({recipes:learning.recipes})};
      }
      computeHandler=createPlusComputeHandler({admission,authenticate:identities.authenticate,recordFailure:record=>storage.auditStore.appendIdempotent(record)});
      }
    }
    if(selectionWorkerIntervalMs&&!selectionWorker)throw error('SELECTION_WORKER_OPT_IN_REQUIRED');
    if(evaluationWorkerIntervalMs&&!evaluationWorker)throw error('EVALUATION_WORKER_OPT_IN_REQUIRED');
    if(decisionWorkerIntervalMs&&!decisionWorker)throw error('DECISION_WORKER_OPT_IN_REQUIRED');
    if(actionExecutionWorkerIntervalMs&&!actionExecutionWorker)throw error('ACTION_EXECUTION_WORKER_OPT_IN_REQUIRED');
  }catch(e){cel?.close();storage.close();throw e;}
  const handler=createPlusControlHandler({storage,tenantId,authenticate:identities.authenticate,
    definitionKeys:async p=>Object.entries(load().definitions).filter(([,entry])=>entry.readRoles.some(role=>p.roles.includes(role))).map(([key])=>key),
    definitionCandidateFor:async(p,key)=>{const entries=load().definitions,entry=Object.hasOwn(entries,key)?entries[key]:undefined;
      if(!entry||!entry.readRoles.some(role=>p.roles.includes(role)))throw error('DEFINITION_FORBIDDEN');
      return entry.candidate===undefined?undefined:structuredClone(entry.candidate);},
    authorizeOntology:async(p,permission)=>(ontologyRoles[permission]??[]).some(role=>p.roles.includes(role)),
    authorizeDefinition:async(p,permission,key)=>{
      const definitions=load().definitions,entry=Object.hasOwn(definitions,key)?definitions[key]:undefined;if(!entry)return false;
      const field=permission==='definition:read'?'readRoles':permission==='definition:publish'?'publishRoles':'draftRoles';
      return entry[field].some(role=>p.roles.includes(role));
    },
    policyFor:async(_p,key)=>{const definitions=load().definitions,entry=Object.hasOwn(definitions,key)?definitions[key]:undefined;if(!entry)throw error('DEFINITION_FORBIDDEN');return structuredClone(entry.policy);},
    recordFailure:record=>storage.auditStore.appendIdempotent(record),
    readGovernance:({mode,query,principal,catalog,reauthenticate})=>createPrivateGovernanceView({storage,tenantId,identities,loadPolicy:load,catalog,reauthenticate,
      hostState:()=>({workers:[{key:'audit',state:structuredClone(workerState)},{key:'selection',state:selectionWorker?.state()??{status:'DISABLED'}},
        {key:'evaluation',state:evaluationWorker?.state()??{status:'DISABLED'}},{key:'decision',state:decisionWorker?.state()??{status:'DISABLED'}},{key:'action',state:actionExecutionWorker?.state()??{status:'DISABLED'}}]})}).read(mode,query,principal),
    readObject:({type,id,principal,catalog,reauthenticate})=>createPrivateObjectReader({storage,tenantId,identities,loadPolicy:load,catalog,reauthenticate}).read(type,id,principal),
    listObjects:({type,query,principal,catalog,reauthenticate})=>createPrivateObjectReader({storage,tenantId,identities,loadPolicy:load,catalog,reauthenticate}).list(type,query,principal),
    readLinks:({type,id,query,principal,catalog,reauthenticate})=>createPrivateObjectReader({storage,tenantId,identities,loadPolicy:load,catalog,reauthenticate}).links(type,id,query,principal),
    analyzeObject:({type,id,query,principal,catalog,reauthenticate})=>createPrivateObjectReader({storage,tenantId,identities,loadPolicy:load,catalog,reauthenticate}).analysis(type,id,query,principal),
    createEpisodeRuntime:({catalog,definitions,reauthenticate})=>createTaskEpisodeRuntime({storage,catalog,definitions,tenantId,identities,loadPolicy:load,reauthenticate,cel}),
    executeTask:async({action,input,principal,key,catalog,reauthenticate})=>{
      if(!cel)throw Object.assign(error('TASK_RULE_SERVICE_NOT_CONFIGURED'),{status:503});
      const access=createTaskDomainAccess({storage,tenantId,loadPolicy:load,reauthenticate});
      if(action==='NativeImportTaskMatter')return createMatterIntakeDomain({storage,catalog,cel,tenantId,...access}).execute(input,principal,key);
      if(action==='NativeImportTaskRule')return createRuleIntakeDomain({storage,catalog,cel,tenantId,...access}).execute(input,principal,key);
      if(action==='NativeSetTaskPriority')return createTaskPriorityDomain({storage,catalog,cel,tenantId,...access}).execute(input,principal,key);
      return createTaskDomain({storage,catalog,cel,tenantId,...access}).execute(action,input,principal,key);
    },
  });
  let stopped=false,timer,active,closing,selectionTimer,selectionActive,evaluationTimer,evaluationActive,decisionTimer,decisionActive,actionExecutionTimer,actionExecutionActive;
  const background=createNativeBackgroundSequence(),auditGate=createNativeAuditGate();
  async function selectionCycle(){try{await background.run(()=>selectionWorker.run());}finally{
    if(!stopped)selectionTimer=setTimeout(()=>{selectionActive=selectionCycle();},selectionWorkerIntervalMs);
  }}
  async function evaluationCycle(){try{await background.run(()=>evaluationWorker.run());}finally{
    if(!stopped)evaluationTimer=setTimeout(()=>{evaluationActive=evaluationCycle();},evaluationWorkerIntervalMs);
  }}
  async function decisionCycle(){try{await background.run(()=>decisionWorker.run());}finally{
    if(!stopped)decisionTimer=setTimeout(()=>{decisionActive=decisionCycle();},decisionWorkerIntervalMs);
  }}
  async function actionExecutionCycle(){try{await background.run(()=>actionExecutionWorker.run());}finally{
    if(!stopped)actionExecutionTimer=setTimeout(()=>{actionExecutionActive=actionExecutionCycle();},actionExecutionWorkerIntervalMs);
  }}
  const worker=new ActionOutboxWorker({storage,context:{tenantId,actorId:system.id},authorize:async()=>{
    try{load();await catalog.read(system);return true;}catch{return false;}
  },deliver:async(envelope,key)=>{await storage.auditStore.appendIdempotent(envelope.audit);await refreshSink?.deliver(envelope,key);}});
  const workerState={status:workerIntervalMs?'STARTING':'DISABLED',lastRunAt:null,lastResult:null,lastError:null,outboxHealth:null,initialization:null};
  function cycle(){return background.run(()=>auditGate.audit(async()=>{
    try{
      workerState.lastResult=await worker.drain();
      workerState.initialization=await refreshInitializer?.run()??null;
      // An empty sweep is not recovery: failed durable rows and errored leases
      // waiting for expiry must remain visible across cycles and host restarts.
      const failed=await storage.queryObjects({tenantId},'PlusOutbox',{field:'status',operator:'eq',value:'FAILED'},{limit:1});
      const waiting=await storage.queryObjects({tenantId},'PlusOutbox',{and:[{field:'status',operator:'eq',value:'LEASED'},
        {or:['OUTBOX_DELIVERY_FAILED','OUTBOX_AUTHORIZATION_REVOKED'].map(value=>({field:'errorCode',operator:'eq',value}))}]},{limit:1});
      workerState.outboxHealth={failed:failed.totalCount,retryWaiting:waiting.totalCount};
      const deliveryFailed=workerState.lastResult.failed||failed.totalCount||waiting.totalCount,initializationFailed=workerState.initialization?.status==='DEGRADED';
      workerState.status=deliveryFailed||initializationFailed?'DEGRADED':'RUNNING';workerState.lastError=deliveryFailed?'OUTBOX_DELIVERY_FAILED':initializationFailed?'BELIEF_REFRESH_INITIALIZATION_FAILED':null;
    }
    catch{workerState.status='FAILED';workerState.lastError='AUDIT_WORKER_FAILED';workerState.lastResult=null;workerState.outboxHealth=null;workerState.initialization=null;}
    finally{workerState.lastRunAt=new Date().toISOString();if(!stopped)timer=setTimeout(()=>{active=cycle();},workerIntervalMs);}
  }));}
  const inFlight=new Set();
  const server=createServer((req,res)=>{
    const request=(async()=>{try{await auditGate[isNativeComputeMetadataRequest(req)?'metadata':'foreground'](async()=>{
      if(computeHandler&&await computeHandler(req,res))return;
      if(learningHandler&&await learningHandler(req,res))return;
      if(!await handler(req,res)){res.writeHead(404,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({error:{code:'NOT_FOUND'}}));}
    });}catch{if(!res.headersSent)res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{code:'PLUS_INTERNAL_ERROR'}}));}})();
    inFlight.add(request);void request.then(()=>inFlight.delete(request),()=>inFlight.delete(request));
  });
  server.requestTimeout=10000;server.headersTimeout=10000;
  try{await new Promise((accept,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.removeListener('error',reject);accept();});});}
  catch(e){cel?.close();storage.close();throw e;}
  let backgroundStarted=false;
  function startBackgroundWorkers(){
    if(stopped)throw error('BACKGROUND_WORKER_HOST_STOPPED');
    if(backgroundStarted)return;
    load();identities.assertConfigured();backgroundStarted=true;
    if(workerIntervalMs)active=cycle();
    if(selectionWorker)selectionActive=selectionCycle();
    if(evaluationWorker)evaluationActive=evaluationCycle();
    if(decisionWorker)decisionActive=decisionCycle();
    if(actionExecutionWorker)actionExecutionActive=actionExecutionCycle();
  }
  if(!deferBackgroundWorkers){try{startBackgroundWorkers();}catch(e){
    stopped=true;server.closeAllConnections();await new Promise(r=>server.close(r));cel?.close();storage.close();throw e;
  }}
  return {url:`http://127.0.0.1:${server.address().port}`,ontologyHash:current.bundle.contentHash,mode:computeHandler?'plus-v2-control-with-private-fit':learningHandler?'plus-v2-control-with-learning':'plus-v2-control-only',computeEnabled:!!computeHandler,learningEnabled:!!learningHandler,predictionReady:false,
    startBackgroundWorkers,
    workerState:()=>structuredClone(workerState),
    selectionWorkerState:()=>selectionWorker?.state()??{status:'DISABLED',predictionReady:false},
    evaluationWorkerState:()=>evaluationWorker?.state()??{status:'DISABLED',predictionReady:false},
    decisionWorkerState:()=>decisionWorker?.state()??{status:'DISABLED',predictionReady:false},
    actionExecutionWorkerState:()=>actionExecutionWorker?.state()??{status:'DISABLED',predictionReady:false},
    inFlightRequests:()=>inFlight.size,
    async close(){if(closing)return closing;stopped=true;clearTimeout(timer);clearTimeout(selectionTimer);clearTimeout(evaluationTimer);clearTimeout(decisionTimer);clearTimeout(actionExecutionTimer);closing=(async()=>{
      const backgroundClosing=background.close(),selectionClosing=selectionWorker?.close(),evaluationClosing=evaluationWorker?.close(),decisionClosing=decisionWorker?.close(),actionExecutionClosing=actionExecutionWorker?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
      await Promise.allSettled([...inFlight]);await active;await selectionActive;await evaluationActive;await decisionActive;await actionExecutionActive;await selectionClosing;await evaluationClosing;await decisionClosing;await actionExecutionClosing;await backgroundClosing;await auditGate.close();cel?.close();storage.close();})();return closing;}};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const runtime=await startPlusControlServer({dbPath:process.env.PLUS_V2_DB_PATH,authPath:process.env.LWM_AUTH_FILE,policyPath:process.env.PLUS_V2_POLICY_FILE,
    tenantId:process.env.PLUS_V2_TENANT,port:Number(process.env.PLUS_V2_PORT??0),celAddress:process.env.PLUS_V2_CEL_ADDRESS,
    selectionWorkerIntervalMs:Number(process.env.PLUS_V2_SELECTION_WORKER_INTERVAL_MS??0),evaluationWorkerIntervalMs:Number(process.env.PLUS_V2_EVALUATION_WORKER_INTERVAL_MS??0),decisionWorkerIntervalMs:Number(process.env.PLUS_V2_DECISION_WORKER_INTERVAL_MS??0),actionExecutionWorkerIntervalMs:Number(process.env.PLUS_V2_ACTION_EXECUTION_WORKER_INTERVAL_MS??0)});
  console.log(JSON.stringify({url:runtime.url,mode:runtime.mode,ontologyHash:runtime.ontologyHash,predictionReady:false}));
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void runtime.close().then(()=>process.exit(0));});
}

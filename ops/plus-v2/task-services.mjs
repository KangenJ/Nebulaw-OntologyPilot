// Shared actual private service graph for HTTP, event delivery and diagnostics.
// No listener, installation, data seeding, approval or token fallback.
import { NativeOntologyCatalog,NativeDefinitionRegistry,NativeComputeAdmission,NativePublishedModelReference,NativeLearnedCompositionMaterial,createNativeReadQualificationPhase } from '../../platform/packages/plus-runtime/dist/index.js';
import { createPrivateAuthorizationRevision } from './private-authority.mjs';
import { createTaskLearningServices } from '../../platform/apps/lwm-demo/src/task-learning.mjs';
import { createPrivateComputeAccess } from './compute-access.mjs';
import { createPrivateComputeAuthorizationServices } from './compute-authorization-services.mjs';
import { createPrivateNativeComputeAccess } from './native-compute-access.mjs';
import { createNativeComputeRecipeBindingResolver } from './native-recipe-selection.mjs';
import { createPrivateEvaluationServices } from './evaluation-services.mjs';
import { createPrivateModelGovernanceServices } from './model-governance.mjs';
import { createPrivateModelSelectionJobServices } from './model-selection-job-services.mjs';
import { createPrivateModelEvaluationJobServices } from './model-evaluation-job-services.mjs';
import { createPrivateModelDecisionJobServices } from './model-decision-job-services.mjs';
import { createPrivateActionExecutionJobServices } from './action-execution-job-services.mjs';
import { createPrivateEvaluationSubmissionCatalog } from './evaluation-submission-catalog.mjs';
import { createPrivateModelDecisionReviewCatalog } from './model-decision-review-catalog.mjs';
import { createPrivateReplayServices } from './replay-governance.mjs';
import { createPrivateBeliefServices } from './belief-services.mjs';
import { createPrivateBeliefJobServices } from './belief-job-services.mjs';
import { createPrivateScenarioServices } from './scenario-services.mjs';
import { createPrivateActionRequestServices } from './action-request-services.mjs';
import { createPrivateActionIntervalAccess,createPrivateActionIntervalServices } from './action-interval-services.mjs';
import { createPrivateTaskRuleServices } from './task-rule-services.mjs';
import { createPrivateRecipeAuthoring } from './recipe-authoring-services.mjs';
import { createPrivateNativeFitVerifiers as createRegisteredNativeFitVerifiers } from '../../services/plus-engine/private-fit-registry.mjs';
import { createPrivateFitRegistration } from './fit-qualification.mjs';
import { createNativeCompositionRecipeValidation } from '../../services/plus-engine/native-composition-recipe.mjs';
import { createNativeLearnedCompositionRecipeValidation } from '../../services/plus-engine/native-learned-composition-recipe.mjs';
import { learnedCompositionEstimatorId } from '../../services/plus-engine/learned-composition.mjs';
const error=code=>Object.assign(new Error(code),{code});
const ontologyRoles={ 'ontology:read':['viewer','investigator','data_reviewer','trainer','model_owner','case_reviewer'], 'ontology:draft':['data_reviewer'], 'ontology:validate':['data_reviewer'], 'ontology:publish':['model_owner'] };
export function createPrivateTaskServices({storage,tenantId,identities,loadPolicy,cel,celAddress,reauthenticate,syntheticCompleteFitQualification,reviewedCompleteFit}){
  const registration=createPrivateFitRegistration({tenantId,loadPolicy,syntheticCompleteFitQualification,reviewedCompleteFit});
  loadPolicy=registration.loadPolicy;
  const intervalOptions={storage,tenantId,identities,loadPolicy,reauthenticate};
  const assertIntervalDependencies=()=>{const policy=loadPolicy();if(policy.actionIntervals?.enabled===true&&(!cel||['taskDomain','taskLearning','evaluation','modelGovernance','replayGovernance','beliefRuntime','scenarioPlanning','actionRequests'].some(key=>policy[key]?.enabled!==true)))throw error('ACTION_INTERVAL_DEPENDENCY_CONFIGURATION_REQUIRED');};
  assertIntervalDependencies();
  if(loadPolicy().learnedCompositionReplay?.enabled===true&&(loadPolicy().beliefRuntime?.enabled!==true||loadPolicy().taskRules?.enabled!==true||loadPolicy().actionIntervals?.enabled!==true||!celAddress))throw error('BELIEF_COMPLETE_DEPENDENCY_CONFIGURATION_REQUIRED');
  if(loadPolicy().compositionReplay?.enabled===true&&(loadPolicy().beliefRuntime?.enabled!==true||loadPolicy().taskRules?.enabled!==true||!celAddress))throw error('BELIEF_COMPOSITION_DEPENDENCY_CONFIGURATION_REQUIRED');
  if(loadPolicy().taskRules?.enabled===true&&(loadPolicy().taskLearning?.enabled!==true||loadPolicy().taskDomain?.enabled!==true||!cel))throw error('TASK_RULE_DEPENDENCY_CONFIGURATION_REQUIRED');
  if(loadPolicy().actionRequests?.enabled===true&&(loadPolicy().scenarioPlanning?.enabled!==true||loadPolicy().taskDomain?.enabled!==true||!cel))throw error('ACTION_REQUEST_DEPENDENCY_CONFIGURATION_REQUIRED');
  if(loadPolicy().scenarioPlanning?.enabled===true&&loadPolicy().beliefRuntime?.enabled!==true)throw error('SCENARIO_BELIEF_CONFIGURATION_REQUIRED');
  if(loadPolicy().beliefRefresh?.enabled===true&&loadPolicy().beliefJobs?.enabled!==true)throw error('BELIEF_REFRESH_JOBS_CONFIGURATION_REQUIRED');
  if(loadPolicy().beliefJobs?.enabled===true&&loadPolicy().beliefRuntime?.enabled!==true)throw error('BELIEF_JOB_RUNTIME_CONFIGURATION_REQUIRED');
  if(loadPolicy().beliefRuntime?.enabled===true&&loadPolicy().replayGovernance?.enabled!==true)throw error('BELIEF_RUNTIME_REPLAY_CONFIGURATION_REQUIRED');
  if(loadPolicy().replayGovernance?.enabled===true&&loadPolicy().modelGovernance?.enabled!==true)throw error('REPLAY_GOVERNANCE_MODEL_CONFIGURATION_REQUIRED');
  if(loadPolicy().selectionJobs?.enabled===true&&(loadPolicy().evaluation?.enabled!==true||loadPolicy().modelGovernance?.enabled!==true))throw error('SELECTION_JOB_NATIVE_GOVERNANCE_REQUIRED');
  if(loadPolicy().evaluationJobs?.enabled===true&&loadPolicy().evaluation?.enabled!==true)throw error('EVALUATION_JOB_NATIVE_EVALUATION_REQUIRED');
  if(loadPolicy().actionIntervals!==undefined)createPrivateActionIntervalAccess(intervalOptions).assertConfigured();
  const assertCurrent=async p=>{await reauthenticate?.();const current=await identities.resolvePrincipal(p.id);if(current.tenantId!==p.tenantId||JSON.stringify([...current.roles].sort())!==JSON.stringify([...p.roles].sort()))throw error('DATASET_TASK_PRINCIPAL_FORBIDDEN');await reauthenticate?.();};
  const dataCatalog=new NativeOntologyCatalog({storage,tenantId,authorize:async(p,permission)=>{await assertCurrent(p);return (ontologyRoles[permission]??[]).some(role=>p.roles.includes(role));}});
  const dataDefinitions=new NativeDefinitionRegistry({storage,catalog:dataCatalog,tenantId,
    authorize:async(p,permission,key)=>{await assertCurrent(p);const entries=loadPolicy().definitions,entry=Object.hasOwn(entries,key)?entries[key]:undefined;
      const field=permission==='definition:read'?'readRoles':permission==='definition:publish'?'publishRoles':'draftRoles';return !!entry&&entry[field].some(role=>p.roles.includes(role));},
    policyFor:async(p,key)=>{await assertCurrent(p);const entries=loadPolicy().definitions,entry=Object.hasOwn(entries,key)?entries[key]:undefined;if(!entry)throw error('DEFINITION_FORBIDDEN');return structuredClone(entry.policy);}});
  let rules,actionRequests,evaluation,learning,governance;
  const intervals=loadPolicy().actionIntervals?.enabled===true?createPrivateActionIntervalServices({...intervalOptions,catalog:dataCatalog,
    requests:{read:(...args)=>{if(!actionRequests)throw error('ACTION_INTERVAL_DEPENDENCY_CONFIGURATION_REQUIRED');return actionRequests.actionRequests.read(...args);}}}):undefined;
  const validationIntervals=loadPolicy().actionIntervals?.enabled===true?createPrivateActionIntervalServices({...intervalOptions,catalog:dataCatalog,usagePurpose:'TRANSITION_VALIDATE',
    requests:{read:(...args)=>{if(!actionRequests)throw error('ACTION_INTERVAL_DEPENDENCY_CONFIGURATION_REQUIRED');return actionRequests.actionRequests.read(...args);}}}):undefined;
  const completeIntervals=loadPolicy().actionIntervals?.enabled===true?createPrivateActionIntervalServices({...intervalOptions,catalog:dataCatalog,usagePurpose:'LEARNED_COMPOSITION_VALIDATE',
    requests:{read:(...args)=>{if(!actionRequests)throw error('ACTION_INTERVAL_DEPENDENCY_CONFIGURATION_REQUIRED');return actionRequests.actionRequests.read(...args);}}}):undefined;
  const onlineIntervals=loadPolicy().learnedCompositionReplay?.enabled===true?createPrivateActionIntervalServices({...intervalOptions,catalog:dataCatalog,usagePurpose:'LEARNED_COMPOSITION_ONLINE',
    requests:{read:(...args)=>{if(!actionRequests)throw error('ACTION_INTERVAL_DEPENDENCY_CONFIGURATION_REQUIRED');return actionRequests.actionRequests.read(...args);}}}):undefined;
  const componentDecisions={requireComponentApproved:(...args)=>{
    if(!governance)throw error('RECIPE_COMPONENT_PROVIDER_REQUIRED');return governance.decisions.requireComponentApproved(...args);
  }};
  const ruleSpecifications={requireApproved:(...args)=>{
    if(!rules)throw error('COMPOSITION_RECIPE_QUALIFIER_REQUIRED');return rules.ruleSpecifications.requireApproved(...args);
  }};
  const observationRecipeValidation=loadPolicy().taskRules?.enabled===true?createNativeCompositionRecipeValidation({definitions:dataDefinitions,ruleSpecifications}):undefined;
  const learnedRecipeValidation=observationRecipeValidation?createNativeLearnedCompositionRecipeValidation({definitions:dataDefinitions,ruleSpecifications,componentDecisions,
    recipes:{requireApproved:(...args)=>{if(!learning)throw error('LEARNED_COMPOSITION_NATIVE_PROVIDERS_REQUIRED');return learning.recipes.requireApproved(...args);}}}):undefined;
  const compositionRecipes=observationRecipeValidation?{
    validateRecipe:(payload,...args)=>(payload.engineId===learnedCompositionEstimatorId?learnedRecipeValidation:observationRecipeValidation).validateRecipe(payload,...args),
    qualifyDependencies:(payload,...args)=>(payload.engineId===learnedCompositionEstimatorId?learnedRecipeValidation:observationRecipeValidation).qualifyDependencies(payload,...args),
    authorizationRevision:createPrivateAuthorizationRevision({tenantId,identities,loadPolicy,reauthenticate})}:undefined;
  const actionIntervals=intervals?{read:async(...args)=>{assertIntervalDependencies();const result=await intervals.actionIntervals.read(...args);assertIntervalDependencies();return result;}}:undefined;
  const validationActionIntervals=validationIntervals?{read:async(...args)=>{assertIntervalDependencies();const result=await validationIntervals.actionIntervals.read(...args);assertIntervalDependencies();return result;}}:undefined;
  // Same native protocol service, lazily linked to resolve the service graph.
  // This creates no approval and does not register a new scoring capability.
  const evaluationProtocols={requireApproved:(...args)=>{if(!evaluation)throw error('TRANSITION_VALIDATION_PROTOCOL_PROVIDER_REQUIRED');return evaluation.protocols.requireApproved(...args);}};
  learning=createTaskLearningServices({storage,catalog:dataCatalog,definitions:dataDefinitions,tenantId,identities,loadPolicy,cel,reauthenticate,
    compositionRecipes,componentDecisions,actionIntervals,validationActionIntervals,evaluationProtocols});
  rules=loadPolicy().taskRules?.enabled===true?createPrivateTaskRuleServices({storage,catalog:dataCatalog,tenantId,identities,loadPolicy,cel,reauthenticate,definitions:dataDefinitions,episodes:learning.temporalInputs}):undefined;
  const recipeWorkbenchConfiguration={storage,catalog:dataCatalog,tenantId,identities,loadPolicy,reauthenticate,definitions:dataDefinitions,learning,rules,componentDecisions,
    componentReferences:{configured:()=>!!governance,listKeys:p=>governance?governance.componentKeys(p):Promise.resolve([]),
      list:(...args)=>{if(!governance)throw error('RECIPE_COMPONENT_PROVIDER_REQUIRED');return governance.decisions.listForComposition(...args);}}};
  const recipeWorkbench=createPrivateRecipeAuthoring(recipeWorkbenchConfiguration);
  const ruleAdapters={recipeWorkbench,...(rules?{ruleSpecifications:rules.ruleSpecifications,ruleResults:rules.ruleResults,ruleWorkbench:rules.ruleWorkbench}:{})};
  const pinnedQualification=registration.nativeRecipeQualification;
  // Integrity-only private reader. A worker need not gain ontology browsing
  // privileges just to enforce this installation pin; no bundle is returned.
  const reviewSystem={id:'plus-reviewed-fit-catalog',tenantId,roles:[]};
  const reviewedCatalog=registration.reviewedOntologyHash===undefined?undefined:new NativeOntologyCatalog({storage,tenantId,
    authorize:async(p,permission)=>p.id===reviewSystem.id&&p.tenantId===tenantId&&permission==='ontology:read'});
  const checkReviewedOntology=async p=>{await assertCurrent(p);const current=await reviewedCatalog.read(reviewSystem);
    if(current.bundle.contentHash!==registration.reviewedOntologyHash)throw error('REVIEWED_FIT_ONTOLOGY_MISMATCH');await assertCurrent(p);};
  const nativeRecipeQualification=registration.reviewedOntologyHash===undefined?pinnedQualification:{
    allowsMetadata:async(item,p)=>{await checkReviewedOntology(p);return pinnedQualification.allowsMetadata(item);},
    requireQualified:async(approved,p)=>{await checkReviewedOntology(p);return pinnedQualification.requireQualified(approved);},
  };
  const computeAuthorizationServices=loadPolicy().computeAuthorizations!==undefined?createPrivateComputeAuthorizationServices({storage,tenantId,identities,loadPolicy,reauthenticate,
    engineIds:registration.engineIds,datasets:learning.datasets,recipes:learning.recipes,recipeKeysForRoot:learning.recipeKeysForRoot,
    nativeRecipeQualification}):undefined;
  const computeAuthorizationAdapters=loadPolicy().computeAuthorizations?.enabled===true?{
    computeAuthorizations:computeAuthorizationServices.computeAuthorizations,computeAuthorizationPurposes:computeAuthorizationServices.computeAuthorizationPurposes,
    computeAuthorizationWorkbench:computeAuthorizationServices.computeAuthorizationWorkbench}:{};
  // Lookup only binds the exact predeclared native revision. This same graph's
  // NativeComputeAdmission independently qualifies recipe:use before any job,
  // material handoff or result; do not use the binding resolver as an approval.
  const recipeSelections=loadPolicy().compute?.jobs?.some(j=>j?.policy?.recipeSelection)?createNativeComputeRecipeBindingResolver({storage,tenantId,identities,loadPolicy,reauthenticate,recipes:learning.recipes}):undefined;
  const nativeCompute=loadPolicy().compute?.version==='plus-private-compute-v4';
  const computeAccess=nativeCompute?createPrivateNativeComputeAccess({storage,tenantId,identities,loadPolicy,reauthenticate,engineIds:registration.engineIds,
    computeAuthorizations:computeAuthorizationServices?.computeAuthorizations}):createPrivateComputeAccess({tenantId,identities,loadPolicy,engineIds:registration.engineIds,recipeSelections});
  if(loadPolicy().evaluation?.enabled!==true){
    if(loadPolicy().modelGovernance?.enabled===true)throw error('MODEL_GOVERNANCE_EVALUATION_CONFIGURATION_REQUIRED');
    const computeConfiguration=nativeCompute?{storage,tenantId,datasets:learning.datasets,recipes:learning.recipes,transitionPlans:learning.transitionPlans,...computeAccess,
      computeAuthorizations:computeAuthorizationServices.computeAuthorizations,...createRegisteredNativeFitVerifiers({recipes:learning.recipes})}:undefined;
    if(computeConfiguration)computeConfiguration.readQualificationPhase=createNativeReadQualificationPhase({storage,tenantId,
      readers:[dataCatalog,dataDefinitions,learning.temporalInputs,learning.recipes,learning.datasets,learning.partitions,learning.feedback],
      authorizationRevision:createPrivateAuthorizationRevision({tenantId,identities,loadPolicy,reauthenticate})});
    return {...learning,...ruleAdapters,...computeAuthorizationAdapters,...(computeConfiguration?{computeConfiguration}:{}),
      assertConfigured:()=>{learning.assertConfigured();rules?.assertConfigured();computeAuthorizationServices?.assertConfigured();if(nativeCompute)computeAccess.assertConfigured();}};
  }
  let completeMaterial;
  const computeConfiguration={storage,tenantId,datasets:learning.datasets,recipes:learning.recipes,transitionPlans:learning.transitionPlans,...computeAccess,
    ...(nativeCompute?{computeAuthorizations:computeAuthorizationServices.computeAuthorizations}:{}),
    readConsistency:'SHARED_NATIVE_AND_AUTHORITY',authorizationRevision:createPrivateAuthorizationRevision({tenantId,identities,loadPolicy,reauthenticate}),
    learnedComposition:{materializeForFit:(...args)=>completeMaterial.materializeForFit(...args),revalidateForFit:(...args)=>completeMaterial.revalidateForFit(...args)},
    ...createRegisteredNativeFitVerifiers({recipes:learning.recipes})};
  const compute=new NativeComputeAdmission(computeConfiguration);
  const completeMaterialConfiguration={storage,tenantId,recipes:learning.recipes,componentDecisions,compute,datasets:learning.datasets,
    // This server-only material provider grants no job or publication authority.
    // Compute gates submission/result access; the provider independently checks
    // current native recipe/component and every observation/ancestor FIT grant.
    authorize:async p=>{await assertCurrent(p);return loadPolicy().taskRules?.enabled===true&&loadPolicy().modelGovernance?.enabled===true;},
    authorizationRevision:createPrivateAuthorizationRevision({tenantId,identities,loadPolicy,reauthenticate})};
  completeMaterial=new NativeLearnedCompositionMaterial(completeMaterialConfiguration);
  if(loadPolicy().evaluation.protocols?.some(e=>e.purpose?.reference)&&loadPolicy().modelGovernance?.enabled!==true)throw error('EVALUATION_REFERENCE_GOVERNANCE_REQUIRED');
  // Lazy dependency edges wire the SAME native graph. They grant no permission,
  // supply no approval, and never create a second selection authority.
  let referenceReader;
  const publishedReferences={capture:(...a)=>{if(!referenceReader)throw error('EVALUATION_REFERENCE_GOVERNANCE_REQUIRED');return referenceReader.capture(...a);},
    requireQualified:(...a)=>{if(!referenceReader)throw error('EVALUATION_REFERENCE_GOVERNANCE_REQUIRED');return referenceReader.requireQualified(...a);}};
  const learnedCompositionReferences={captureLearnedComposition:(...a)=>{if(!referenceReader)throw error('EVALUATION_REFERENCE_GOVERNANCE_REQUIRED');return referenceReader.captureLearnedComposition(...a);},
    requireLearnedCompositionQualified:(...a)=>{if(!referenceReader)throw error('EVALUATION_REFERENCE_GOVERNANCE_REQUIRED');return referenceReader.requireLearnedCompositionQualified(...a);}};
  const coldStarts={captureColdStart:(...a)=>{if(!governance)throw error('EVALUATION_REFERENCE_GOVERNANCE_REQUIRED');return governance.deployments.captureColdStart(...a);},
    requireColdStart:(...a)=>{if(!governance)throw error('EVALUATION_REFERENCE_GOVERNANCE_REQUIRED');return governance.deployments.requireColdStart(...a);}};
  const completeHistory=completeIntervals?{historyAuthority:completeIntervals.historyAuthority,
    actionIntervals:{read:async(...args)=>{assertIntervalDependencies();const result=await completeIntervals.actionIntervals.read(...args);assertIntervalDependencies();return result;}}}:undefined;
  // This graph constructs ALL lineage providers from the same storage and the
  // same full policy/current identity authority, including token expiry. Only
  // here can read-only final fences reuse the current invocation's traversal.
  // Not read from user policy/HTTP, not shared across requests or commands.
  const readConsistency='SHARED_NATIVE_AND_AUTHORITY';
  evaluation=createPrivateEvaluationServices({storage,tenantId,identities,loadPolicy,reauthenticate,learning,compute,publishedReferences,readConsistency,
    learnedCompositionReferences,coldStarts,completeHistory});
  governance=loadPolicy().modelGovernance?.enabled===true?createPrivateModelGovernanceServices({storage,tenantId,identities,loadPolicy,reauthenticate,evaluations:evaluation.evaluations,recipes:learning.recipes,readConsistency}):undefined;
  const selectionJobs=loadPolicy().selectionJobs?.enabled===true?createPrivateModelSelectionJobServices({storage,tenantId,identities,loadPolicy,reauthenticate,deployments:governance?.deployments}):undefined;
  const evaluationJobs=loadPolicy().evaluationJobs?.enabled===true?createPrivateModelEvaluationJobServices({storage,tenantId,identities,loadPolicy,reauthenticate,evaluations:evaluation.evaluations}):undefined;
  const decisionJobs=loadPolicy().decisionJobs?.enabled===true?createPrivateModelDecisionJobServices({storage,tenantId,identities,loadPolicy,reauthenticate,decisions:governance?.decisions}):undefined;
  const modelReview=decisionJobs?createPrivateModelDecisionReviewCatalog({storage,tenantId,identities,loadPolicy,reauthenticate,
    evaluations:evaluation.evaluations,protocols:evaluation.protocols,recipes:learning.recipes,resultKeys:evaluation.resultKeys,authorizeEvaluation:evaluation.protocolConfiguration.authorize}):undefined;
  const evaluationOptions=evaluationJobs?createPrivateEvaluationSubmissionCatalog({storage,tenantId,identities,loadPolicy,reauthenticate,compute,protocols:evaluation.protocols,datasets:learning.datasets,authorizeEvaluation:evaluation.protocolConfiguration.authorize}):undefined;
  // Only these actual native instances can reuse completed recipe/component/protocol
  // reads, inside a read-only phase fenced by THIS graph's full authority and
  // native epoch. Each independent precommit/exposure phase starts fresh.
  let readQualificationPhase;
  if(governance||nativeCompute){
    readQualificationPhase=createNativeReadQualificationPhase({storage,tenantId,
      readers:[dataCatalog,dataDefinitions,learning.temporalInputs,learning.recipes,learning.datasets,learning.partitions,learning.feedback,...(governance?[governance.decisions]:[]),compute,evaluation.protocols],authorizationRevision:createPrivateAuthorizationRevision({tenantId,identities,loadPolicy,reauthenticate})});
    computeConfiguration.readQualificationPhase=readQualificationPhase;
    completeMaterialConfiguration.readQualificationPhase=readQualificationPhase;
    evaluation.protocolConfiguration.readQualificationPhase=readQualificationPhase;
    recipeWorkbenchConfiguration.readQualificationPhase=readQualificationPhase;
    if(governance)governance.decisionConfiguration.readQualificationPhase=readQualificationPhase;
  }
  if(governance)referenceReader=new NativePublishedModelReference({storage,tenantId,deployments:governance.deployments,recipes:learning.recipes,compute,learnedCompositionCompute:compute,
    authorizationRevision:createPrivateAuthorizationRevision({tenantId,identities,loadPolicy,reauthenticate})});
  const replay=loadPolicy().replayGovernance?.enabled===true?createPrivateReplayServices({storage,tenantId,identities,loadPolicy,reauthenticate,deployments:governance?.deployments,readConsistency}):undefined;
  const completeOnlineHistory=onlineIntervals?{historyAuthority:onlineIntervals.historyAuthority,
    actionIntervals:{read:async(...args)=>{assertIntervalDependencies();const result=await onlineIntervals.actionIntervals.read(...args);assertIntervalDependencies();return result;}}}:undefined;
  const beliefs=loadPolicy().beliefRuntime?.enabled===true?createPrivateBeliefServices({storage,tenantId,identities,loadPolicy,reauthenticate,
    authorizations:replay?.authorizations,episodes:learning.temporalInputs,recipes:learning.recipes,compute,ruleResults:rules?.ruleResults,celAddress,
    datasets:learning.datasets,partitions:learning.partitions,completeOnlineHistory,readQualificationPhase}):undefined;
  const beliefJobs=loadPolicy().beliefJobs?.enabled===true?createPrivateBeliefJobServices({storage,tenantId,identities,loadPolicy,reauthenticate,beliefs:beliefs?.beliefs}):undefined;
  const scenarios=loadPolicy().scenarioPlanning?.enabled===true?createPrivateScenarioServices({storage,catalog:dataCatalog,tenantId,identities,loadPolicy,reauthenticate,beliefs:beliefs?.beliefs,definitions:dataDefinitions,recipes:learning.recipes,compute,readQualificationPhase}):undefined;
  actionRequests=loadPolicy().actionRequests?.enabled===true?createPrivateActionRequestServices({storage,catalog:dataCatalog,tenantId,identities,loadPolicy,reauthenticate,cel,scenarios:scenarios?.scenarios,readConsistency}):undefined;
  const actionExecutionJobs=loadPolicy().actionExecutionJobs?.enabled===true?createPrivateActionExecutionJobServices({storage,tenantId,identities,loadPolicy,reauthenticate,actionRequests:actionRequests?.actionRequests}):undefined;
  return {...learning,...ruleAdapters,...computeAuthorizationAdapters,computeConfiguration,evaluationProtocols:evaluation.protocols,modelEvaluations:evaluation.evaluations,...(governance?{modelDecisions:governance.decisions,modelDeployments:governance.deployments}:{}),
    ...(replay?{replayAuthorizations:replay.authorizations}:{}),
    ...(beliefs?{beliefs:beliefs.beliefs}:{}),
    ...(beliefJobs?{beliefJobs:beliefJobs.beliefJobs}:{}),
    ...(selectionJobs?{selectionJobs:selectionJobs.selectionJobs}:{}),
    ...(evaluationJobs?{evaluationJobs:evaluationJobs.evaluationJobs}:{}),
    ...(decisionJobs?{decisionJobs:decisionJobs.decisionJobs}:{}),
    ...(modelReview?{modelReview}:{}),
    ...(evaluationOptions?{evaluationOptions}:{}),
    ...(scenarios?{scenarios:scenarios.scenarios,scenarioWorkbench:scenarios.scenarioWorkbench}:{}),
    ...(actionRequests?{actionRequests:actionRequests.actionRequests,actionReviewCatalog:actionRequests.actionReviewCatalog,actionProposalCatalog:actionRequests.actionProposalCatalog}:{}),
    ...(actionExecutionJobs?{actionExecutionJobs:actionExecutionJobs.actionExecutionJobs,actionExecutionCatalog:actionExecutionJobs.actionExecutionCatalog}:{}),
    assertConfigured:()=>{learning.assertConfigured();rules?.assertConfigured();computeAuthorizationServices?.assertConfigured();computeAccess.assertConfigured();evaluation.assertConfigured();governance?.assertConfigured();selectionJobs?.assertConfigured();evaluationJobs?.assertConfigured();decisionJobs?.assertConfigured();replay?.assertConfigured();beliefs?.assertConfigured();beliefJobs?.assertConfigured();scenarios?.assertConfigured();actionRequests?.assertConfigured();actionExecutionJobs?.assertConfigured();intervals?.assertConfigured();}};
}

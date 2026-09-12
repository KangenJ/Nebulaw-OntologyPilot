import {readNativeRuntimeProfile} from '../../../../ops/plus-v2/runtime-host.mjs';

// Actual normal source intake against the existing learning installation.
// No direct object writes, rule service substitutions or seeded approvals.
export async function nativeRulePurposeInput(f,profilePath){
  await f.start(readNativeRuntimeProfile(profilePath));
  const source=await f.ok('data_reviewer','/actions/NativeImportTaskRule',{ruleKey:'normal-priority-source',title:'SYNTHETIC native priority source',versionTag:'v1',effectiveFrom:new Date(Date.now()-1000).toISOString(),
    sourceCitation:'SYNTHETIC operator-declared source, separately reviewed rule expression required',sourceSystem:'demo-rule',sourceRecordId:'normal-rule-source',sourceRevision:'1'},'normal-rule-source-import');
  const object=(await f.ok('viewer','/objects/RuleVersion/'+source.receipt.resultId)).object;
  await f.runtime().close();
  return {schema:'plus-native-rule-purpose-request-v1',profilePath,outputParent:f.parent,directoryName:'rule-purpose',definitionKey:'task.completion',expectedDefinitionHash:f.input.expectedDefinitionHash,
    workspaceKey:'demo',specificationKey:'task.priority-rule',purposeId:'reviewed-priority-rule-purpose',principals:f.input.principals,bindings:[{moduleKey:'priorityRecommendation',sourceId:object._id,expectedSourceVersion:object._version}]};
}

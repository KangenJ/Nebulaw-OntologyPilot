import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { CelClient } from '../../platform/packages/actions/dist/index.js';
import { compileComposition,recompileComposition,digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { fixture } from '../../platform/packages/plus-contracts/tests/fixture.mjs';
import { baselineFor } from './observation-fit-fixture.mjs';
import { createFiniteEngine } from './finite-engine.mjs';
import { createRuleBackend } from './rule-backend.mjs';

// Compatibility of the explicit compiler outputs with the REAL fixed backends.
// Synthetic configured kernels/references only, not a learned candidate, native
// composition model admission, shared snapshot qualification or atomic results.
test('explicit composition projections execute finite statistics and actual CEL without enabling direct mixed-model or rule-as-state input',async t=>{
  const f=fixture(),priority=f.definition.variables.find(v=>v.key==='priority');
  f.context.policy.implementationIds.push('typed-cel-rule-v1');f.context.policy.fieldSemantics['Task.status'].roles.push('RULE_DERIVED');
  f.definition.variables.push({...structuredClone(priority),key:'recommendation',role:'RULE_DERIVED',source:{objectType:'Task',field:'status'},valueType:'String',support:['INSPECT']});
  f.definition.modules.push({key:'recommend',kind:'RULE',inputs:['priority'],outputs:['recommendation'],dependsOn:[],implementation:'typed-cel-rule-v1'});
  const contract=recompileComposition(compileComposition(f.definition,f.context),f.context),baseline=baselineFor(contract.statistics);
  // This configured perfect observation kernel is an engineering oracle, not
  // learned business efficacy. Different new reports must change the belief.
  for(const row of baseline.hypotheses[0].channels[0].rows)for(const outcome of row.probabilities)
    outcome.p=outcome.value.kind==='VALUE'&&outcome.value.value===row.state.state?1:0;
  assert.throws(()=>createFiniteEngine(contract.parent,baseline),e=>e.code==='UNSUPPORTED_MODULE');
  const stats=createFiniteEngine(contract.statistics,baseline),initial=stats.initialize({episodeKey:'synthetic-composition',context:{priority:1}});
  const event=value=>({key:'fresh-report',step:0,variable:'report',kind:'OBSERVATION',value:{kind:'VALUE',value},dependenceKey:'independent-software-source',verificationMode:'NONE'});
  const done=stats.summarize(stats.update(initial,event('DONE'))),notDone=stats.summarize(stats.update(initial,event('NOT_DONE')));
  assert.equal(done.joint.find(v=>v.state.state==='DONE').p,1);assert.equal(notDone.joint.find(v=>v.state.state==='NOT_DONE').p,1);
  assert.notDeepEqual(done,notDone);
  const ref=id=>({id,version:1,hash:digest({id,synthetic:true})});
  const rules=createRuleBackend(contract.parent,{schema:'plus-rule-spec-v1',definitionHash:contract.parent.definitionHash,
    rules:[{moduleKey:'recommend',ruleRevision:ref('synthetic-rule'),when:{op:'EQ',left:'priority',right:{kind:'LITERAL',value:2}},outputs:{recommendation:'INSPECT'}}]});
  const binary=process.env.LWM_CEL_BINARY;assert.ok(binary,'Actual CEL required; no evaluator substitute');
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
  const child=spawn(binary,[],{env:{...process.env,CEL_HOST:'127.0.0.1',CEL_PORT:String(port)},stdio:'ignore',windowsHide:true});
  let spawnError;child.on('error',e=>{spawnError=e;});const client=new CelClient({address:`127.0.0.1:${port}`,maxRetries:0,timeoutMs:1000,circuitBreakerResetMs:100});
  t.after(async()=>{client.close();if(!spawnError&&child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill();await ended;}});
  let ready=false;for(let i=0;i<60;i++){if(spawnError)throw spawnError;if(child.exitCode!==null)break;try{if((await client.evaluate('true',{})).value===true){ready=true;break;}}catch{}await delay(100);}assert.ok(ready);
  const input=value=>({schema:'plus-rule-input-v1',definitionHash:contract.parent.definitionHash,dependencyHash:contract.parent.dependencyHash,snapshot:ref('synthetic-input'),values:{priority:{kind:'VALUE',value}}});
  const evaluateCel=(...args)=>client.evaluate(...args),one=await rules.evaluate(input(1),{evaluateCel}),two=await rules.evaluate(input(2),{evaluateCel});
  assert.deepEqual(one.results[0].outputs.recommendation,{kind:'UNDETERMINED',reason:'PRECONDITION_FALSE'});
  assert.deepEqual(two.results[0].outputs.recommendation,{kind:'VALUE',value:'INSPECT'});
  assert.equal(two.predictionReady,false);assert.equal(two.businessFactsWritten,false);
  assert.throws(()=>stats.update(initial,{...event('DONE'),variable:'recommendation'}),e=>e.code==='EVENT_VARIABLE');
  assert.equal(contract.reviewRequired,undefined);assert.equal(contract.predictionReady,false);
  assert.equal(stats.description.estimator,'REVIEWED_FINITE_REFERENCE_NOT_FITTED');
});

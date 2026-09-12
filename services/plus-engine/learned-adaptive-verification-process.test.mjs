import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createIsolatedLearnedAdaptiveVerificationPlanner as create} from './learned-adaptive-verification-process.mjs';

test('fixed adaptive process rejects caller programs, environment and unbounded limits',()=>{
  for(const options of [{command:'node'},{env:{}},{workerPath:'other'},{timeoutMs:0},{timeoutMs:30001},{maxOutputBytes:4194305},{maxOutputBytes:0}])assert.throws(()=>create(options),/CONFIGURATION_INVALID/);
});

test('real worker validates input and never exposes arbitrary error details',async()=>{
  await assert.rejects(create().compare({}),{code:'SCENARIO_ADAPTIVE_INPUT_INVALID'});
  await assert.rejects(create().compare({x:NaN}),{code:'SCENARIO_PROCESS_REQUEST_INVALID'});
  await assert.rejects(create().compare({x:'x'.repeat(48*1024*1024)}),{code:'SCENARIO_PROCESS_INPUT_LIMIT'});
  await assert.rejects(create().compare({},{}),{code:'SCENARIO_PROCESS_CONFIGURATION_INVALID'});
});

test('real child timeout, pre-abort, in-flight abort and cross-factory capacity recover after close',async()=>{
  await assert.rejects(create({timeoutMs:1}).compare({}),{code:'SCENARIO_PROCESS_TIMEOUT'});
  const pre=new AbortController();pre.abort('private-reason');await assert.rejects(create().compare({},pre.signal),{code:'SCENARIO_PROCESS_ABORTED'});
  const a=new AbortController(),b=new AbortController();
  const pa=create().compare({},a.signal),pb=create().compare({},b.signal);
  const checks=[assert.rejects(pa,{code:'SCENARIO_PROCESS_ABORTED'}),assert.rejects(pb,{code:'SCENARIO_PROCESS_ABORTED'})];
  await assert.rejects(create().compare({}),{code:'SCENARIO_PROCESS_BUSY'});
  a.abort();b.abort();await Promise.all(checks);
  await assert.rejects(create().compare({}),{code:'SCENARIO_ADAPTIVE_INPUT_INVALID'});
});

// Isolated FAULT WORKERS below are explicit transport doubles. The production
// factory has no worker-path/command/env injection. Genuine valid model output
// is separately exercised by learned-composition-belief.test.mjs.
async function faultWorker(t,source){
  const dir=mkdtempSync(join(tmpdir(),'plus-adaptive-process-fault-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const module=readFileSync(new URL('./learned-adaptive-verification-process.mjs',import.meta.url),'utf8')
    .replace('../../platform/packages/plus-contracts/dist/index.js',new URL('../../platform/packages/plus-contracts/dist/index.js',import.meta.url).href)
    .replace('../../platform/packages/plus-runtime/dist/index.js',new URL('../../platform/packages/plus-runtime/dist/index.js',import.meta.url).href);
  writeFileSync(join(dir,'process.mjs'),module);writeFileSync(join(dir,'learned-adaptive-verification-once.mjs'),source);
  return (await import(pathToFileURL(join(dir,'process.mjs')).href)).createIsolatedLearnedAdaptiveVerificationPlanner;
}

test('fault worker invalid JSON, unexpected exit, bounded stdout/stderr and forged success fail closed',async t=>{
  for(const [source,code,options] of [
    ["process.stdout.write('not-json')",'SCENARIO_PROCESS_RESPONSE_INVALID'],
    ["process.kill(process.pid,'SIGKILL')",'SCENARIO_PROCESS_EXIT_FAILED'],
    ["process.stdout.write('x'.repeat(100))",'SCENARIO_PROCESS_OUTPUT_LIMIT',{maxOutputBytes:10}],
    ["process.stderr.write('x'.repeat(70000))",'SCENARIO_PROCESS_OUTPUT_LIMIT'],
    ["process.stdout.write(JSON.stringify({schema:'plus-adaptive-process-response-v1',requestHash:'forged',resultHash:'forged',result:{}}))",'SCENARIO_PROCESS_RESPONSE_INVALID'],
    ["process.stdout.write(JSON.stringify({schema:'plus-adaptive-process-error-v1',code:'private token message'}));process.exitCode=2",'SCENARIO_PROCESS_EXIT_FAILED'],
  ]){const fixed=await faultWorker(t,source);await assert.rejects(fixed(options).compare({}),{code});}
});

test('fault probe confirms child does not inherit parent credentials or NODE_OPTIONS',async t=>{
  const original=process.env.PLUS_PROCESS_TEST_SECRET,previous=process.env.NODE_OPTIONS;
  process.env.PLUS_PROCESS_TEST_SECRET='test-only-do-not-inherit';process.env.NODE_OPTIONS='--trace-warnings';
  try{
    const fixed=await faultWorker(t,"process.stdout.write(JSON.stringify({schema:'plus-adaptive-process-error-v1',code:process.env.PLUS_PROCESS_TEST_SECRET||process.env.NODE_OPTIONS?'ENVIRONMENT_LEAK':'ENVIRONMENT_ISOLATED'}));process.exitCode=2");
    await assert.rejects(fixed().compare({}),{code:'ENVIRONMENT_ISOLATED'});
  }finally{if(original===undefined)delete process.env.PLUS_PROCESS_TEST_SECRET;else process.env.PLUS_PROCESS_TEST_SECRET=original;if(previous===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=previous;}
});

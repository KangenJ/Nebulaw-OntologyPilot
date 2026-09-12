// Reproducible engineering evidence. Does not migrate/restart the running demo.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const root=fileURLToPath(new URL('../../',import.meta.url));
const platform=join(root,'platform');
const pnpm=join(root,'.tools/node_modules/pnpm/bin/pnpm.cjs');
if(!existsSync(pnpm))throw new Error('Run using the isolated engineering root with its locked pnpm installation');
if(!process.env.LWM_CEL_BINARY||!existsSync(process.env.LWM_CEL_BINARY))throw new Error('LWM_CEL_BINARY must identify the canonical evaluator');
const evidenceRoot=join(root,'var/plus-v2');mkdirSync(evidenceRoot,{recursive:true});
const dir=mkdtempSync(join(evidenceRoot,'t02-core-'));
// Loss of the observer's stdout must not terminate native verification. Progress
// persists independently; a RUNNING report is never proof of a live process/pass.
process.stdout.on('error',error=>{if(error.code!=='EPIPE')throw error;});
const report={scope:'T02 foundation and partial T03/T04/T06/R3: native governance, finite inference, temporal inputs/current inventory, observation U2 FIT/recipes/evaluation, independent model admission/selection/online consent, actual native FIT-to-heldout-score-to-fresh-disjoint-source-event/outbox/private-HTTP-job/fixed-child/belief/reopen/withdrawal; belief CAS/training-source guards/read cache, native BELIEF_REPLAY jobs with current submitter authority/hashed leases/bounded attempts/discovery/exhaustion/cancel/atomic belief-head-and-receipt completion; explicit current-identity event subscriptions, same-inventory capture/queue deduplication, strict reviewed time grid, source-withdrawal refresh, trigger-link/audit atomicity and recovery, persistent outbox-failure visibility across host restarts; explicit late-subscription initialization from current approved configuration, native job deduplication after initializer restart, credential/configuration reinitialization, bounded retry cadence, per-subscription failure isolation and unapproved initialization refused by the actual host; fixed bounded child without inherited credentials/NODE_OPTIONS, loopback worker with ambiguous-completion reconciliation and actual worker SIGKILL/fresh-daemon wall-clock lease recovery; reviewed native priority action and optional timed registration, initial-prefix time contracts with independent compilation policy and complete-history/commit-time authorization, v2 Task snapshot/history/current-input projection and exact field grants; bounded read-only connection recovery with sanitized diagnostics, never automatic claim/write retries; Task data/recipe and private FIT dispatch. Focused job/HTTP/daemon tests still have explicit upstream governance doubles, distinct from the real native model-event chain; all Machine source fixtures are SYNTHETIC and not canonical Task or production-host acceptance. No complete real-model switching/rollback replay or API-host crash recovery during replay, future assessment, learned transitions, neural training, main activation or full G1 acceptance',startedAt:new Date().toISOString(),node:process.version,commands:[],sources:{},passed:false,
  remaining:['source deletion recovery, historical audit, complete real-model switching/rollback replay, complete canonical Task/host inference failure recovery','Task reviewed real-clock provisioning/online inference, learning workbench UI, durable EVAL dispatch, operational scheduler deployment and multi-dataset fitting','future-state evaluation, transition supervision/fitting, pure rules, neural comparison, sealed evaluation, two-round full update/clean model-and-belief rollback and governed planning/execution','reviewed main-database migration and integrated v2 activation','full G1 A01–A21 verification']};
report.scope+='; additional targets: Task revision-2 actual FIT/independent state evaluation/selection followed by canonical Task registration and report at wall-clock registration time (step 0), real file-backed private host, exact source outbox, HTTP belief job/fixed child/reopen and consent withdrawal; SQLite per-read data-version invalidation and exact-content pure ontology parser reuse (not authority/model-qualification caches); same-target GOLD verification decision-loss comparison using published definition utility, explicit availability/cost assumptions, current native ScenarioRun admission and lineage links, private HTTP access and withdrawal refusal. A scenario alone confers no action authority. Scenario unit/HTTP fixtures have explicit upstream governance doubles; the expanded canonical Task host checks real model-to-scenario lineage. Scenario-enabled startup rejects missing published links without automatic migration. Aggregate read-only diagnostics never infer liveness/readiness. Host performance and full arbitrary event-time provisioning remain acceptance requirements, not implied by source existence.';
report.scope+='; canonical Task preparation shares native parameter validation and execution rules, performs no writes, and stages real registration/report/independent verification in the outer strict transaction. Tests cover detached inputs, current permission/source policy, actor/tenant scope, consumed plans, CAS, rollback and native receipts/outbox. Earlier primitive composition fixtures explicitly seed approval metadata. Separate NativeActionRequests tests create actual proposals and independent decisions with immutable version/hash binding, then qualify current proposer/approver/executor and atomically register a follow-up Task with request-bound receipt and both journals. Existing decisions are audit references, not newly-created effects. Private action-request HTTP uses strict input and explicit key/episode/action/actor grants, original-token reauthentication, canonical CEL and native field rights; startup refuses missing metadata/dependencies without migration. Focused action HTTP fixtures explicitly stub model/scenario admission. The full Task model host separately targets actual fitted/held-out-evaluated/approved model to scenario, investigator proposal, independent case reviewer approval, canonical registration, host reopen/idempotent reconciliation, and historical receipt reads after model withdrawal. Registration is not physical verification, GOLD feedback, full two-round learning or main-service activation.';
function collect(path,output){
  for(const entry of readdirSync(path,{withFileTypes:true})){
    if(['node_modules','dist','.turbo'].includes(entry.name))continue;
    const child=join(path,entry.name);if(entry.isDirectory())collect(child,output);
    else if(/\.(ts|mjs|json|yaml|odl)$/.test(entry.name))output[relative(root,child)]=createHash('sha256').update(readFileSync(child)).digest('hex');
  }
}
function persist(){const path=join(dir,'report.json');writeFileSync(path+'.tmp',JSON.stringify(report,null,2));renameSync(path+'.tmp',path);}
function sources(){const output={};
  for(const path of ['platform/packages/spi/src','platform/packages/odl/src','platform/packages/actions/src','platform/packages/storage-memory/src','platform/packages/plus-contracts','platform/packages/plus-runtime','platform/domain-packs/core','platform/domain-packs/lwm-demo','platform/domain-packs/lwm-plus','platform/domain-packs/plus-core','platform/apps/lwm-demo/src','services/plus-engine','ops/plus-v2'])collect(join(root,path),output);
  for(const path of ['platform/pnpm-lock.yaml','platform/turbo.json','platform/package.json'])output[path]=createHash('sha256').update(readFileSync(join(root,path))).digest('hex');return output;
}
report.sources=sources();
report.pid=process.pid;report.state='RUNNING';persist();
const commands=[
  ['workspace-build',[pnpm,'build']],['workspace-typecheck',[pnpm,'typecheck']],['workspace-tests',[pnpm,'test']],
  ['finite-engine',['--test',...readdirSync(join(root,'services/plus-engine')).filter(n=>n.endsWith('.test.mjs')).map(n=>'../services/plus-engine/'+n)]],
  ['runtime-native-control',['--test',...readdirSync(join(platform,'packages/plus-runtime/tests')).filter(n=>n.endsWith('.test.mjs')).map(n=>'packages/plus-runtime/tests/'+n)]],
  ['strict-canonical-cel',['--test','packages/plus-runtime/tests/canonical-cel.acceptance.mjs']],
  ['task-domain-native',['--test','packages/plus-runtime/tests/task-domain.acceptance.mjs']],
  ['legacy-native-integration',['--test','apps/lwm-demo/tests/native-platform.acceptance.mjs']],
  ['legacy-regressions',['--test',...readdirSync(join(platform,'apps/lwm-demo/tests')).filter(n=>n.endsWith('.test.mjs')).map(n=>'apps/lwm-demo/tests/'+n)]],
];
try{
  for(const [name,args] of commands){
    const record={name,command:[process.execPath,...args],cwd:platform,startedAt:new Date().toISOString()};report.commands.push(record);
    persist();console.log('START '+name);
    const child=spawn(process.execPath,args,{cwd:platform,windowsHide:true,env:{...process.env,TURBO_TELEMETRY_DISABLED:'1'},stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>output+=v);
    record.exitCode=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',(code,signal)=>{record.signal=signal;resolve(code);});});
    record.endedAt=new Date().toISOString();record.log=name+'.log';writeFileSync(join(dir,record.log),output);
    persist();console.log('END '+name+' exit='+record.exitCode);
    if(record.exitCode!==0)throw new Error(name+' failed; inspect '+join(dir,record.log));
  }
  const finalSources=sources();report.sourceChanges=[...new Set([...Object.keys(report.sources),...Object.keys(finalSources)])].filter(path=>report.sources[path]!==finalSources[path]);
  if(report.sourceChanges.length)throw new Error('Source files changed during verification; results cannot certify one source snapshot');
  report.passed=true;
}catch(error){report.error=error.message;process.exitCode=1;}
finally{report.endedAt=new Date().toISOString();report.state=report.passed?'PASSED':'FAILED';persist();console.log('Evidence: '+dir);}

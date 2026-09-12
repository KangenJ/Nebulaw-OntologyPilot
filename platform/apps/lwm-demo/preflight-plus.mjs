import {readFileSync,writeFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {inferP33} from './src/plus-workbenches.mjs';
const base=process.env.LWM_PLUS_URL??'http://127.0.0.1:4183';
if(!['127.0.0.1','localhost','[::1]'].includes(new URL(base).hostname))throw new Error('Only loopback preflight is supported');
const credentials=JSON.parse(readFileSync(process.env.LWM_ACCESS_FILE??'var/lwm/plus-access/local-access.json'));
const viewer=credentials.credentials.find(c=>c.role==='viewer');
const headers={authorization:'Bearer '+viewer.token};
const health=await fetch(base+'/api/health'),unauthorized=await fetch(base+'/api/state');
const response=await fetch(base+'/api/state',{headers});if(!response.ok)throw new Error('Viewer credentials expired or service unavailable');
const {data}=await response.json();
const model=await inferP33({queries:[{l:1,f:0,prev_action:0,requested_action:0,lawfulness:1}],demonstrations:[]});
const database=new DatabaseSync(process.env.LWM_NATIVE_DATABASE_PATH??'var/lwm/plus-platform.sqlite',{readOnly:true});
let integrity;try{integrity=database.prepare('PRAGMA quick_check').get().quick_check;}finally{database.close();}
const report={checkedAt:new Date().toISOString(),mode:data.mode,health:health.status,unauthenticatedStatus:unauthorized.status,integrity,model,objectCounts:Object.fromEntries(Object.entries(data.objects).map(([k,v])=>[k,v.totalCount])),receipts:data.objects.NativeCommandReceipt.totalCount,auditRecords:data.audit.length,cloudDeploymentVerified:false};
report.passed=report.health===200&&report.unauthenticatedStatus===401&&integrity==='ok'&&model.parameters===25826;
const output=process.argv.find(a=>a.startsWith('--output='));if(output)writeFileSync(output.slice(9),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;

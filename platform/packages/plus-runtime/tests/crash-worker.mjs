import { fixture } from './fixture.mjs';
import { basename, dirname } from 'node:path';
// Only invoked by the isolated parent test. Never use a live database here.
const path=process.argv[2];
if(!process.send || !path || !basename(dirname(path)).startsWith('plus-outbox-test-')) throw new Error('isolated IPC test required');
const f=await fixture(path);
const result=await f.run();
if(!result.success) throw new Error(JSON.stringify(result.errors));
process.send({committed:true,actionId:result.actionId});
setInterval(()=>{},1000); // Parent kills this confirmed-live process immediately after durable commit.

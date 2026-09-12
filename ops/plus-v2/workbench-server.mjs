import {once} from 'node:events';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {createAppServer} from '../../platform/apps/lwm-demo/server.mjs';

// Opt-in loopback gateway for the existing shell. Does not bootstrap a database,
// mint credentials, grant permissions, start models or switch the main service.
export async function startNativeWorkbenchServer({platformUrl,port=0}={}){
  if(typeof platformUrl!=='string'||!platformUrl)throw Error('PLUS_CONTROL_URL_REQUIRED');
  if(!Number.isSafeInteger(port)||port<0||port>65535)throw Error('INVALID_WORKBENCH_PORT');
  const server=createAppServer({platformUrl,platformApiPrefix:'/api/plus/v2',assetsRoot:fileURLToPath(new URL('../../platform/apps/lwm-demo/public-plus/',import.meta.url))});
  server.listen(port,'127.0.0.1');await once(server,'listening');
  return {url:'http://127.0.0.1:'+server.address().port,close:async()=>{server.closeAllConnections();await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const host=await startNativeWorkbenchServer({platformUrl:process.env.PLUS_CONTROL_URL,port:Number(process.env.PLUS_WORKBENCH_PORT??4183)});
  console.log('Native Plus workbench (loopback, current control authority): '+host.url);
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void host.close().then(()=>process.exit(0)));
}

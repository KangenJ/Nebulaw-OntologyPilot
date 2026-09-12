// Fixed module allowlist. No query/header/local-storage mode selection and no
// legacy fallback if configuration or native loading fails.
export async function bootWorkbench({request=globalThis.fetch,load=path=>import(path),document=globalThis.document}={}){
  try{
    const response=await request('/workbench-config',{cache:'no-store',redirect:'error'});
    if(!response.ok)throw Error('工作台配置不可用');
    const config=await response.json();
    if(config.version!=='plus-workbench-config-v1'||!['native-v2','legacy'].includes(config.mode))throw Error('工作台配置不兼容');
    if(config.mode==='native-v2')await (await load('./native-workbench.js')).startNativeWorkbench();
    else await load('./app.js');
  }catch{
    document.querySelector('#login-form').hidden=true;
    document.querySelector('#access-file').disabled=true;
    const error=document.querySelector('#login-error');error.hidden=false;error.textContent='无法确认工作台接口模式，已停止登录。请检查网关配置后刷新；不会回退到其他平台。';
  }
}
if(typeof document!=='undefined')void bootWorkbench();

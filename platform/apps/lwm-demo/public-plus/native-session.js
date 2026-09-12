// Presentation validation only. Identity and permissions remain server-owned.
export const sessionError=(code,status)=>Object.assign(Error(code),{code,status});
export function normalizeAccessToken(value){
  const token=String(value??'').trim().replace(/^Bearer\s+/i,'').trim();
  // Private identity accepts an Authorization header of at most 4096 bytes.
  if(!token||/^Bearer$/i.test(token)||token.length>4089||!/^[\x21-\x7e]+$/.test(token))throw sessionError('INVALID_ACCESS_TOKEN');
  return token;
}
export function validatedPrincipal(value){
  const validText=text=>typeof text==='string'&&text.length>0&&text.length<=256&&text.trim()===text&&!/[\x00-\x1f\x7f]/.test(text);
  if(!value||Array.isArray(value)||!validText(value.id)||!validText(value.tenantId)||!Array.isArray(value.roles)||
    value.roles.length>32||!value.roles.every(validText)||new Set(value.roles).size!==value.roles.length)throw sessionError('INVALID_PLATFORM_RESPONSE');
  return {id:value.id,tenantId:value.tenantId,roles:[...value.roles]};
}
export function loginErrorMessage(error){
  if(error.code==='INVALID_ACCESS_TOKEN')return '请输入有效的个人访问令牌；不要包含空白或换行。';
  if(error.code==='NETWORK_ERROR')return '无法连接登录服务，请检查网络或服务运行状态。';
  if(error.code==='READ_TIMEOUT')return '平台读取超过当前请求的等待预算，请稍后重新读取；不要因此重复提交训练、审批或动作。';
  if(error.status===403)return '当前身份没有此租户或入口的访问权限，请联系管理员确认授权。';
  if(error.status>=500)return '登录服务或身份配置暂不可用，请联系管理员检查服务状态。';
  if(error.code==='INVALID_PLATFORM_RESPONSE'||error.status===404)return '登录响应不符合当前平台协议，请检查服务入口与部署版本。';
  return '登录未完成，请检查当前部署入口或联系管理员。';
}

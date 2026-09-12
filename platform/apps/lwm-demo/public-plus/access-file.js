// Presentation-only parser. File roles/tenant are labels, never authentication
// claims; the server still authenticates the selected opaque token on each call.
export function parseAccessFile(raw,now=Date.now()){
  const fail=message=>{throw new Error(message);};
  if(typeof raw!=='string'||raw.length>50000)fail('访问文件过大或格式无效');
  let data;try{data=JSON.parse(raw);}catch{fail('访问文件不是有效 JSON');}
  if(!data||typeof data!=='object'||Array.isArray(data))fail('请选择个人 credential.json 或已分配的访问文件，不是服务端 auth.json');
  const validText=v=>typeof v==='string'&&v.length>0&&v.length<=200&&!/[\u0000-\u001f\u007f]/.test(v);
  const token=v=>typeof v==='string'&&v.length>0&&v.length<=4096&&/^[!-~]+$/.test(v);
  const expiry=typeof data.expiresAt==='string'?Date.parse(data.expiresAt):NaN;
  if(!Number.isFinite(now)||!Number.isFinite(expiry))fail('访问文件缺少有效到期时间');
  if(expiry<=now)fail('访问文件已过期，请管理员为本人重新签发凭据；不能关闭服务端过期检查');
  if(data.schema==='plus-private-personal-credential-v1'){
    if(!validText(data.id)||!validText(data.tenantId)||!token(data.token)||!Array.isArray(data.roles)||data.roles.length<1||data.roles.length>32
      ||!data.roles.every(validText)||new Set(data.roles).size!==data.roles.length)fail('个人凭据格式无效');
    return {kind:'PERSONAL',expiresAt:data.expiresAt,credentials:[{id:data.id,role:data.roles.join(', '),token:data.token}]};
  }
  if(data.schema!==undefined||!Array.isArray(data.credentials)||data.credentials.length<1||data.credentials.length>32
    ||data.credentials.some(c=>!c||!validText(c.id)||!validText(c.role)||!token(c.token)))fail('访问文件格式不支持，请领取个人 credential.json');
  if(new Set(data.credentials.map(c=>c.token)).size!==data.credentials.length)fail('访问文件包含重复凭据');
  return {kind:'LEGACY_BUNDLE',expiresAt:data.expiresAt,credentials:data.credentials.map(({id,role,token})=>({id,role,token}))};
}

const failure=code=>Object.assign(new Error(code),{code});
export function createComputeClient({baseUrl,readToken,requestTimeoutMs=180000}){
  let url;try{url=new URL(baseUrl);}catch{throw failure('FIT_WORKER_CONFIGURATION');}
  if(typeof baseUrl!=='string'||url.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(url.hostname)||!url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash
    ||typeof readToken!=='function')throw failure('FIT_WORKER_CONFIGURATION');
  if(!Number.isInteger(requestTimeoutMs)||requestTimeoutMs<1||requestTimeoutMs>300000)throw failure('FIT_WORKER_INVALID_LIMIT');
  return {async request(method,path,input){
    if(!['GET','POST'].includes(method)||!/^\/jobs(?:\/[A-Za-z0-9_-]{1,128}(?:\/(claim|complete-fit|fail|cancel|reconcile-exhausted|result))?)?$/.test(path))throw failure('FIT_WORKER_CONFIGURATION');
    const signal=AbortSignal.timeout(requestTimeoutMs);
    for(let attempt=0;attempt<3;attempt++){
    const token=await readToken();if(typeof token!=='string'||!token||token.length>4000||/[\r\n]/.test(token))throw failure('FIT_WORKER_CREDENTIAL_INVALID');
    let response;
    try{response=await fetch(url.origin+'/api/plus/v2/compute'+path,{method,redirect:'error',signal,
      headers:{authorization:'Bearer '+token,...(method==='POST'?{'content-type':'application/json'}:{})},...(method==='POST'?{body:JSON.stringify(input)}:{})});}
    catch{throw failure('FIT_TRANSPORT_UNCONFIRMED');}
    const chunks=[];let bytes=0;
    try{for await(const chunk of response.body){bytes+=chunk.length;if(bytes>32*1024*1024)throw failure('FIT_TRANSPORT_RESPONSE_LIMIT');chunks.push(chunk);}}
    catch{throw failure('FIT_TRANSPORT_UNCONFIRMED');}
    let result;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw failure('FIT_TRANSPORT_UNCONFIRMED');}
    if(!result||typeof result!=='object'||Array.isArray(result))throw failure('FIT_TRANSPORT_UNCONFIRMED');
    // Metadata alone may race a committed native lease. Re-read only that
    // typed conflict within the original single deadline. Never replay a claim,
    // mutation, result read, denial or uncertain transport outcome.
    if(!response.ok){const code=result.error?.code;if(response.status===409&&code==='CONFLICT'&&method==='GET'&&/^\/jobs\/[A-Za-z0-9_-]{1,128}$/.test(path)&&attempt<2)continue;throw failure(typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,90}$/.test(code)?code:'FIT_TRANSPORT_REJECTED');}
    if(!result.data)throw failure('FIT_TRANSPORT_UNCONFIRMED');return result.data;
    }
  }};
}

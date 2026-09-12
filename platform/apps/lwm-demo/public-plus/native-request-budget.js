// Server-owned, finite workbench deadlines for full native qualification.
// This changes waiting only: no authorization, retry, worker lease or compute
// resource policy. URL/query/body/headers cannot supply a custom timeout.
const id='[A-Za-z0-9_-]{1,128}',key='[A-Za-z][A-Za-z0-9_.-]{0,127}';
const heavyReads=[new RegExp('^/api/compute/jobs/'+id+'/result$'),new RegExp('^/api/learning/deployments/'+key+'$'),new RegExp('^/api/learning/(?:replay-authorizations|evaluation-protocols|scenarios|action-requests)/'+id+'$'),new RegExp('^/api/learning/beliefs/'+key+'/episodes/'+id+'$')];
const heavyWrites=[/^\/api\/learning\/(?:evaluation-protocols|compute-authorizations|replay-authorizations|belief-jobs|scenarios|action-requests|selection-jobs)$/,new RegExp('^/api/learning/(?:evaluation-protocols|compute-authorizations)/'+id+'/review$'),new RegExp('^/api/learning/action-requests/'+id+'/(?:decisions|execute)$'),/^\/api\/learning\/deployments\/(?:activate|rollback)$/,/^\/api\/learning\/scenarios\/view$/,/^\/api\/source-changes$/,new RegExp('^/api/source-changes/'+id+'/review$')];
export function nativeRequestBudget(method,path){
 if(typeof path!=='string'||path.length>4096)return 15000;
 const pathname=path.split(/[?#]/,1)[0],routes=method==='GET'?heavyReads:method==='POST'?heavyWrites:[];
 return routes.some(route=>route.test(pathname))?60000:15000;
}
export function nativeReadClientBudget(path){const upstream=nativeRequestBudget('GET',path);return upstream===60000?65000:15000;}

// Presentation preflight only. Native source policy, schema and current identity
// remain authoritative. No credentials or receipts in browser persistence.
export const matterIntakeFields=['matterNumber','title','jurisdiction','currentState','riskBand','openedAt','sourceSystem','sourceRecordId','sourceRevision'];
export const taskRegistrationFields=['taskNumber','title','priority','assignee','instructions','dueAt'];
export const ruleIntakeFields=['ruleKey','title','versionTag','effectiveFrom','sourceCitation','sourceSystem','sourceRecordId','sourceRevision'];
const fail=message=>{throw Error(message);};
export function planNativeIntake({kind,input,matter,catalog,now=Date.now()}){
  const root=kind==='MATTER',rule=kind==='RULE',task=kind==='TASK';if(!root&&!rule&&!task)fail('不支持的登记类型');
  const fields=root?matterIntakeFields:rule?ruleIntakeFields:taskRegistrationFields,action=root?'NativeImportTaskMatter':rule?'NativeImportTaskRule':'NativeRegisterInvestigationTask';
  if(!catalog?.bundle?.contentHash||!catalog.bundle.manifests?.[action]||catalog.bundle.disabledActions?.includes(action))fail('当前本体尚未发布此登记动作');
  if(!input||Object.keys(input).sort().join(',')!==[...fields].sort().join(','))fail('请完整填写来源字段');
  for(const field of fields)if(typeof input[field]!=='string'||!input[field].trim()||input[field].trim()!==input[field]||input[field].length>(field==='instructions'?20000:2000)||/[\x00-\x1f\x7f]/.test(input[field]))fail('字段无效：'+field);
  const date=input[root?'openedAt':rule?'effectiveFrom':'dueAt'],ms=Date.parse(date);if(!Number.isFinite(ms)||new Date(ms).toISOString()!==date||(root||rule)&&ms>now)fail('时间须为有效UTC ISO毫秒格式；来源发生时间不能位于未来');
  const bands=catalog.bundle.parsed?.enums?.find(e=>e.name==='RiskBand')?.values?.map(v=>v.name)??[];
  if(!rule&&!bands.includes(input[root?'riskBand':'priority']))fail('请选择已发布本体中的风险/优先级枚举');
  if(task&&(matter?.type!=='Matter'||typeof matter.id!=='string'||!matter.id||!Number.isSafeInteger(matter.version)||matter.version<1))fail('请先选择原生 Matter');
  return {schema:'plus-native-intake-preview-v1',kind,action,resultType:root?'Matter':rule?'RuleVersion':'InvestigationTask',catalogHash:catalog.bundle.contentHash,body:{...structuredClone(input),...(task?{matter:matter.id,expectedVersion:matter.version}:{})}};
}
export function createNativeIntakeCommand(plan,{newKey=()=>crypto.randomUUID()}={}){
  const frozen=structuredClone(plan),key=newKey();let status='PENDING',active=false,invalid=false,reference=null,receiptId=null,message=null;
  const current=()=>{if(invalid)throw Object.assign(Error('登记会话已重置'),{discarded:true});};
  const snapshot=()=>({plan:structuredClone(frozen),status,reference:structuredClone(reference),receiptId,error:message});
  return {snapshot,invalidate(){invalid=true;},async submit(api,epoch){
    current();if(active)fail('登记请求正在执行');if(['COMMITTED','REPLAYED'].includes(status))return snapshot();if(status==='FAILED')fail('请修正并重新预检');
    const uncertain=status==='UNCERTAIN';let posted=false;active=true;
    try{
      const catalog=await api('/ontology',epoch);current();if(catalog?.bundle?.contentHash!==frozen.catalogHash)fail('本体已变化，请核对原请求结果后重新预检');
      status='SUBMITTING';posted=true;const value=await api('/actions/'+frozen.action,epoch,structuredClone(frozen.body),key);current();
      const receipt=value?.receipt,result=value?.sourceReplay?value.result:receipt?{type:receipt.resultType,id:receipt.resultId}:undefined;
      if(value?.success!==true||result?.type!==frozen.resultType||typeof result.id!=='string'||!result.id||!value.sourceReplay&&(receipt.actionName!==frozen.action||typeof receipt._id!=='string'))fail('原生回执无效，请查证原请求');
      reference=structuredClone(result);receiptId=receipt?._id??null;status=value.replayed?'REPLAYED':'COMMITTED';message=null;return snapshot();
    }catch(error){if(error.discarded||invalid)throw error;const definitive=Number.isInteger(error.status)&&error.status>=400&&error.status<500&&![408,429].includes(error.status);status=uncertain||posted&&!definitive?'UNCERTAIN':'FAILED';message=String(error.message);throw error;}
    finally{active=false;}
  }};
}

// Client-side preflight and ephemeral progress only. Native actions remain the
// authority for identity, source qualification, versions, receipts and facts.
export const observationImportFields=['title','summary','reportedCompletion','eventTime','sourceRecordId','sourceRevision'];
export const observationImportLimits={bytes:500000,rows:50};
const action='NativeRecordTaskObservation';
const fail=message=>{throw Error(message);};
const text=(value,name,max=2000)=>{if(typeof value!=='string'||!value.trim()||value.length>max)fail(name+' 必须是非空字符串，最多 '+max+' 字符');return value;};
export function parseObservationFile(raw){
  if(typeof raw!=='string'||new TextEncoder().encode(raw).length>observationImportLimits.bytes)fail('文件超过 500000 字节');
  let rows;try{rows=JSON.parse(raw);}catch{fail('文件必须是 JSON 对象数组');}
  if(!Array.isArray(rows)||rows.length<1||rows.length>observationImportLimits.rows)fail('文件须包含 1–50 条报告');
  if(rows.some(row=>!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).length>100))fail('每条报告须为不超过 100 列的对象');
  return rows;
}
export function planObservationImport({raw,mapping,sourceSystem,channelKey,task,catalog,now=Date.now()}){
  const rows=parseObservationFile(raw);
  if(task?.type!=='InvestigationTask'||typeof task.id!=='string'||!task.id||!Number.isSafeInteger(task.version)||task.version<1)fail('请先在对象浏览器选择原生 InvestigationTask');
  if(!catalog?.bundle?.contentHash||!catalog.bundle.manifests?.[action]||catalog.bundle.disabledActions?.includes(action))fail('当前本体未发布报告导入动作');
  if(!mapping||Object.keys(mapping).length!==observationImportFields.length||observationImportFields.some(field=>!Object.hasOwn(mapping,field)||typeof mapping[field]!=='string'||!mapping[field]))fail('请完整映射六个报告字段');
  if(new Set(Object.values(mapping)).size!==observationImportFields.length)fail('每个目标字段必须映射到不同来源列');
  sourceSystem=text(sourceSystem,'来源系统');channelKey=text(channelKey,'观察通道');
  const seen=new Set();
  const inputs=rows.map((row,index)=>{
    try{
      const input={sourceSystem,channelKey};
      for(const field of observationImportFields){if(!Object.hasOwn(row,mapping[field]))fail('缺少来源列 '+mapping[field]);input[field]=row[mapping[field]];}
      for(const field of ['title','summary','sourceRecordId','sourceRevision'])text(input[field],field,field==='summary'?20000:2000);
      if(!['DONE','NOT_DONE','UNKNOWN',null].includes(input.reportedCompletion))fail('报告值须为 DONE、NOT_DONE、UNKNOWN 或 null');
      // Deliberately bounded format; do not accept JS's rolled-over invalid dates.
      if(typeof input.eventTime!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(input.eventTime))fail('eventTime 须为 UTC ISO 时间（秒或毫秒，Z 结尾）');
      const ms=Date.parse(input.eventTime),canonical=input.eventTime.includes('.')?input.eventTime:input.eventTime.replace('Z','.000Z');
      if(!Number.isFinite(ms)||new Date(ms).toISOString()!==canonical||ms>now)fail('eventTime 无效或位于未来');
      input.eventTime=canonical;
      const sourceKey=JSON.stringify([input.sourceRecordId,input.sourceRevision]);if(seen.has(sourceKey))fail('同一批次来源记录与修订重复');seen.add(sourceKey);
      return input;
    }catch(error){fail('第 '+(index+1)+' 行：'+error.message);}
  });
  return {version:'native-observation-import-v1',task:structuredClone(task),catalogHash:catalog.bundle.contentHash,mapping:structuredClone(mapping),inputs};
}

export function createObservationImportBatch(plan,{newKey=()=>crypto.randomUUID()}={}){
  // Untrusted callers cannot change an in-flight payload by mutating the preview.
  const frozen=structuredClone(plan),entries=frozen.inputs.map(input=>({input,key:newKey(),status:'PENDING'}));
  let active=false,cancelled=false;
  const snapshot=()=>({task:structuredClone(frozen.task),catalogHash:frozen.catalogHash,entries:entries.map(({input,body,key,...entry})=>structuredClone({...entry,sourceRecordId:input.sourceRecordId,sourceRevision:input.sourceRevision}))});
  function ensureCurrent(){if(cancelled)throw Object.assign(Error('导入会话已重置'),{discarded:true});}
  return {
    snapshot,invalidate(){cancelled=true;},
    async run({api,epoch,onProgress=()=>{}}){
      if(active)fail('导入已在运行');ensureCurrent();active=true;
      try{
        for(const entry of entries){
          ensureCurrent();if(['COMMITTED','REPLAYED'].includes(entry.status))continue;
          if(entry.status==='FAILED')fail('已停止，请修正问题后重新预检；原生来源去重会保留已导入结果');
          let posted=false;const wasUncertain=entry.status==='UNCERTAIN';
          try{
            const current=await api('/ontology',epoch);ensureCurrent();
            if(current?.bundle?.contentHash!==frozen.catalogHash)fail('ONTOLOGY_CHANGED：请重新预检');
            if(!entry.body){
              const detail=await api('/objects/InvestigationTask/'+encodeURIComponent(frozen.task.id),epoch);ensureCurrent();
              if(detail?.reference?.type!=='InvestigationTask'||detail.reference.id!==frozen.task.id||!Number.isSafeInteger(detail.reference.version)||detail.reference.version<1)fail('INVALID_TASK_REFERENCE');
              entry.body={...entry.input,task:frozen.task.id,expectedVersion:detail.reference.version};
            }
            // A retry of an uncertain POST reuses the EXACT body/key, including
            // expectedVersion. Never fetch a new version under an old command key.
            entry.status='SUBMITTING';delete entry.error;onProgress(snapshot());posted=true;
            const result=await api('/actions/'+action,epoch,structuredClone(entry.body),entry.key);ensureCurrent();
            const receipt=result?.receipt;
            // NativeCommandReceipt has resultType/resultId, not resultVersion.
            // Read current versions via the authorized object endpoint, never invent one.
            const reference=result?.sourceReplay?result.result:receipt?{type:receipt.resultType,id:receipt.resultId}:undefined;
            if(result?.success!==true||reference?.type!=='Observation'||typeof reference.id!=='string'||!reference.id||result.sourceReplay&&(!Number.isSafeInteger(reference.version)||reference.version<1)||!result.sourceReplay&&(receipt?.actionName!==action||typeof receipt?._id!=='string'))fail('INVALID_NATIVE_RECEIPT');
            entry.reference=structuredClone(reference);entry.receiptId=receipt?._id??null;entry.eventId=result.event?.id??null;
            entry.status=result.replayed?'REPLAYED':'COMMITTED';onProgress(snapshot());
          }catch(error){
            if(error.discarded||cancelled)throw error;
            // Network/5xx/invalid acknowledgement may have happened after commit.
            // Known 4xx refusals are terminal for this preflight; never continue rows.
            const definitive=Number.isInteger(error.status)&&error.status>=400&&error.status<500&&![408,429].includes(error.status);
            entry.status=wasUncertain||posted&&!definitive?'UNCERTAIN':'FAILED';entry.error=String(error.message);onProgress(snapshot());throw error;
          }
        }
        return snapshot();
      }finally{active=false;}
    },
  };
}

// Read-only, aggregate diagnostics. Never opens auth files, prints source facts,
// migrates a database or mistakes a persisted RUNNING record for a live process.
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function inspectNativeProgress(path){
  if(typeof path!=='string'||!path.trim()||path===':memory:')throw new Error('EXISTING_DATABASE_REQUIRED');
  const db=new DatabaseSync(resolve(path),{readOnly:true});
  try{
    db.exec('BEGIN');
    const size=db.prepare('SELECT length(CAST(payload AS BLOB)) AS bytes FROM lwm_state WHERE id=1').get()?.bytes;
    if(!Number.isSafeInteger(size)||size<1||size>128*1024*1024)throw new Error('DIAGNOSTIC_PAYLOAD_LIMIT');
    const saved=JSON.parse(db.prepare('SELECT payload FROM lwm_state WHERE id=1').get().payload);
    if(!Number.isSafeInteger(saved.revision)||saved.revision<0||!Array.isArray(saved.native?.objects))throw new Error('NATIVE_DATABASE_REQUIRED');
    const counts={},statuses={},errors={};
    const allowed=new Set(['InvestigationTask','Observation','PlusEvent','PlusExecution','PlusOutbox','PlusInputSnapshot','PlusBeliefSnapshot','PlusBeliefHead']);
    const statusSet=new Set(['PENDING','LEASED','SUCCEEDED','FAILED','CANCELLED','STALE','DELIVERED','OPEN','IN_PROGRESS','COMPLETED']);
    for(const [,row]of saved.native.objects){if(row._deletedAt||!allowed.has(row._type))continue;
      counts[row._type]=(counts[row._type]??0)+1;
      if(['PlusExecution','PlusOutbox','InvestigationTask'].includes(row._type)){
        const status=statusSet.has(row.status)?row.status:'OTHER',key=row._type+':'+status;statuses[key]=(statuses[key]??0)+1;
        if(typeof row.errorCode==='string'&&/^[A-Z][A-Z0-9_]{0,90}$/.test(row.errorCode))errors[row.errorCode]=(errors[row.errorCode]??0)+1;
      }
    }
    db.exec('COMMIT');return {schema:'plus-private-native-progress-v1',revision:saved.revision,payloadBytes:size,counts,statuses,errors,
      processLivenessChecked:false,predictionReadinessChecked:false,businessFactsWritten:false};
  }finally{db.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  if(process.argv.length!==3)throw new Error('EXPLICIT_DATABASE_PATH_REQUIRED');
  console.log(JSON.stringify(inspectNativeProgress(process.argv[2]),null,2));
}

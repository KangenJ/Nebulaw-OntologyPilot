import {DatabaseSync,backup} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {createReadStream,lstatSync,realpathSync,mkdtempSync,chmodSync,openSync,writeSync,fsyncSync,closeSync,readFileSync,readdirSync,copyFileSync,constants} from 'node:fs';
import {isAbsolute,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const fail=code=>Object.assign(Error(code),{code});
const hash=value=>createHash('sha256').update(value).digest('hex');
const budget={databaseBytes:16*1024**3,payloadBytes:256*1024**2,auditRows:100000};
function pathValue(path){if(typeof path!=='string'||!isAbsolute(path)||/[\x00-\x1f\x7f]/.test(path))throw fail('BACKUP_ABSOLUTE_PATH_REQUIRED');return path;}
function regular(path,max=budget.databaseBytes){
  pathValue(path);const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size<1||s.size>max)throw fail('BACKUP_REGULAR_FILE_REQUIRED');return realpathSync(path);
}
function directory(path,privateOnly=false){
  pathValue(path);const s=lstatSync(path);if(!s.isDirectory()||s.isSymbolicLink())throw fail('BACKUP_DIRECTORY_REQUIRED');
  if(privateOnly&&process.platform!=='win32'&&(s.uid!==process.getuid()||(s.mode&0o077)!==0))throw fail('BACKUP_PRIVATE_DIRECTORY_REQUIRED');
  return realpathSync(path);
}
async function fileHash(path){const sum=createHash('sha256');for await(const chunk of createReadStream(path))sum.update(chunk);return sum.digest('hex');}
function syncFile(path){const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
function syncDirectory(path){if(process.platform==='win32')return;syncFile(path);}
function writeReceipt(path,value){const fd=openSync(path,'wx',0o600);try{writeSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}}
function privateOutput(parent,prefix){const path=mkdtempSync(join(directory(parent),prefix));chmodSync(path,0o700);return path;}
function pairs(value){return Array.isArray(value)&&value.every(p=>Array.isArray(p)&&p.length===2)&&new Set(value.map(p=>p[0])).size===value.length;}

// Offline inventory only. This does not execute actions, authorize a model, or
// prove source eligibility. Preserve the *whole* native snapshot, including
// historical/deleted data, links, schemas, idempotency, jobs and model payloads.
export function inspectNativeDatabase(path){
  const db=new DatabaseSync(regular(path),{readOnly:true});
  try{
    db.exec('BEGIN');
    if(db.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok')throw fail('BACKUP_DATABASE_CORRUPT');
    const row=db.prepare('SELECT revision,payload FROM lwm_state WHERE id=1').get();
    if(!row||Buffer.byteLength(row.payload)>budget.payloadBytes)throw fail('BACKUP_NATIVE_PAYLOAD_REQUIRED');
    const state=JSON.parse(row.payload),native=state.native;
    if(Object.keys(state).sort().join(',')!=='native,revision'||!Number.isSafeInteger(row.revision)||row.revision<0||state.revision!==row.revision
      ||native?.format!=='openfoundry-memory-spi-v1'||!['objects','links','history','schemas','idempotency'].every(k=>pairs(native[k]))
      ||!Number.isSafeInteger(native.schemaVersion)||!native.schemas.some(([version])=>version===native.schemaVersion))throw fail('BACKUP_NATIVE_FORMAT_REQUIRED');
    if(!native.objects.some(([,o])=>o?._type==='PlusOntologyRevision'&&!o._deletedAt))throw fail('BACKUP_PLUS_ONTOLOGY_REQUIRED');
    const auditCount=db.prepare('SELECT COUNT(*) AS count FROM native_audit').get().count;
    if(auditCount>budget.auditRows)throw fail('BACKUP_AUDIT_BUDGET');
    const auditHash=createHash('sha256');for(const item of db.prepare('SELECT rowid,id,record FROM native_audit ORDER BY rowid').iterate())auditHash.update(JSON.stringify(item)+'\n');
    const ddl=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name').all();
    const objectsByType=Object.create(null);for(const [,object] of native.objects){if(!object||typeof object._type!=='string')throw fail('BACKUP_NATIVE_FORMAT_REQUIRED');objectsByType[object._type]=(objectsByType[object._type]??0)+1;}
    return {revision:row.revision,schemaVersion:native.schemaVersion,stateHash:hash(row.payload),auditHash:auditHash.digest('hex'),sqliteSchemaHash:hash(JSON.stringify(ddl)),
      objects:native.objects.length,links:native.links.length,historyKeys:native.history.length,schemas:native.schemas.length,idempotencyKeys:native.idempotency.length,auditRecords:auditCount,objectsByType};
  }catch(e){if(e?.code?.startsWith('BACKUP_'))throw e;throw fail('BACKUP_NATIVE_DATABASE_INVALID');}
  finally{try{db.exec('ROLLBACK');}finally{db.close();}}
}

export async function createNativeBackup({dbPath,outputParent}){
  const source=regular(dbPath);inspectNativeDatabase(source);
  const archiveDirectory=privateOutput(outputParent,'plus-native-backup-'),target=join(archiveDirectory,'platform.sqlite');
  const db=new DatabaseSync(source,{readOnly:true});
  try{
    // SQLite backup API preserves physical audit rowids; VACUUM INTO can
    // renumber tables without INTEGER PRIMARY KEY and break audit cursors.
    await backup(db,target);chmodSync(target,0o600);
    // Only this fresh private copy is writable here. Seal it into a standalone
    // rollback-journal database, never checkpoint or change the live source.
    // Otherwise a read-only check of a WAL-mode copy creates unpinned sidecars.
    const sealed=new DatabaseSync(target);try{
      sealed.exec('PRAGMA synchronous=FULL; PRAGMA wal_checkpoint(TRUNCATE);');
      if(sealed.prepare('PRAGMA journal_mode=DELETE').get()?.journal_mode!=='delete')throw fail('BACKUP_SEAL_FAILED');
    }finally{sealed.close();}
    if(readdirSync(archiveDirectory).join(',')!=='platform.sqlite')throw fail('BACKUP_UNSEALED_FILES');syncFile(target);
    const inventory=inspectNativeDatabase(target),sha256=await fileHash(target);
    const manifest={schema:'plus-native-backup-v1',status:'COMPLETE',createdAt:new Date().toISOString(),file:'platform.sqlite',sha256,inventory,
      sourceModifiedByTool:false,credentialsIncluded:false,policyIncluded:false,codeIncluded:false,externalArtifactsIncluded:false,
      restoreMode:'QUARANTINED_NO_SERVICES',workersStarted:false,predictionReady:false};
    const manifestPath=join(archiveDirectory,'manifest.json');writeReceipt(manifestPath,manifest);syncDirectory(archiveDirectory);
    return {schema:'plus-native-backup-receipt-v1',archiveDirectory,manifestSha256:await fileHash(manifestPath),sha256,inventory,
      credentialsIncluded:false,workersStarted:false,predictionReady:false};
  }catch(e){throw Object.assign(fail(e?.code?.startsWith('BACKUP_')?e.code:'BACKUP_INCOMPLETE'),{archiveDirectory});}
  finally{db.close();}
}

export async function verifyNativeBackup({archiveDirectory,manifestSha256}){
  const root=directory(archiveDirectory,true);
  if(readdirSync(root).sort().join(',')!=='manifest.json,platform.sqlite')throw fail('BACKUP_UNSEALED_FILES');
  if(typeof manifestSha256!=='string'||!/^[a-f0-9]{64}$/.test(manifestSha256))throw fail('BACKUP_PINNED_MANIFEST_REQUIRED');
  const manifestPath=regular(join(root,'manifest.json'),1024*1024);
  if(await fileHash(manifestPath)!==manifestSha256)throw fail('BACKUP_MANIFEST_HASH_MISMATCH');
  let manifest;try{manifest=JSON.parse(readFileSync(manifestPath,'utf8'));}catch{throw fail('BACKUP_MANIFEST_INVALID');}
  if(manifest.schema!=='plus-native-backup-v1'||manifest.status!=='COMPLETE'||manifest.file!=='platform.sqlite'||!/^[a-f0-9]{64}$/.test(manifest.sha256)
    ||manifest.restoreMode!=='QUARANTINED_NO_SERVICES'||manifest.workersStarted!==false||manifest.credentialsIncluded!==false||manifest.predictionReady!==false)throw fail('BACKUP_MANIFEST_INVALID');
  const dbPath=regular(join(root,manifest.file));
  if(await fileHash(dbPath)!==manifest.sha256)throw fail('BACKUP_DATABASE_HASH_MISMATCH');
  if(JSON.stringify(inspectNativeDatabase(dbPath))!==JSON.stringify(manifest.inventory))throw fail('BACKUP_INVENTORY_MISMATCH');
  return {manifest,dbPath};
}

export async function restoreNativeBackup({archiveDirectory,manifestSha256,outputParent}){
  const verified=await verifyNativeBackup({archiveDirectory,manifestSha256}),restoreDirectory=privateOutput(outputParent,'plus-native-restore-'),dbPath=join(restoreDirectory,'platform.sqlite');
  try{
    copyFileSync(verified.dbPath,dbPath,constants.COPYFILE_EXCL);chmodSync(dbPath,0o600);syncFile(dbPath);
    // Recheck copied bytes, not just the potentially changed archive path.
    if(await fileHash(dbPath)!==verified.manifest.sha256)throw fail('BACKUP_RESTORE_HASH_MISMATCH');
    if(JSON.stringify(inspectNativeDatabase(dbPath))!==JSON.stringify(verified.manifest.inventory))throw fail('BACKUP_RESTORE_INVENTORY_MISMATCH');
    const receipt={schema:'plus-native-restore-v1',status:'QUARANTINED',dbPath,manifestSha256,sha256:verified.manifest.sha256,inventory:verified.manifest.inventory,
      workersStarted:false,predictionReady:false,credentialsRestored:false,policyRestored:false,requiresCurrentAuthorization:true,requiresExclusiveCutoverAndLeaseReconciliation:true};
    writeReceipt(join(restoreDirectory,'restore.json'),receipt);syncDirectory(restoreDirectory);return receipt;
  }catch(e){throw Object.assign(fail(e?.code?.startsWith('BACKUP_')?e.code:'BACKUP_RESTORE_INCOMPLETE'),{restoreDirectory});}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    const [operation,a,b,c,...extra]=process.argv.slice(2);let result;
    if(operation==='backup'&&a&&b&&!c&&!extra.length)result=await createNativeBackup({dbPath:a,outputParent:b});
    else if(operation==='verify'&&a&&b&&!c&&!extra.length){const {manifest}=await verifyNativeBackup({archiveDirectory:a,manifestSha256:b});result={schema:'plus-native-backup-check-v1',status:'VERIFIED',inventory:manifest.inventory,workersStarted:false,predictionReady:false};}
    else if(operation==='restore'&&a&&b&&c&&!extra.length)result=await restoreNativeBackup({archiveDirectory:a,manifestSha256:b,outputParent:c});
    else throw fail('BACKUP_EXPLICIT_ARGUMENTS_REQUIRED');
    process.stdout.write(JSON.stringify(result)+'\n');
  }catch(e){process.stdout.write(JSON.stringify({schema:'plus-native-backup-error-v1',code:e?.code?.startsWith('BACKUP_')?e.code:'BACKUP_OPERATION_FAILED',
    ...(e.archiveDirectory?{archiveDirectory:e.archiveDirectory}:{}),...(e.restoreDirectory?{restoreDirectory:e.restoreDirectory}:{}),workersStarted:false,predictionReady:false})+'\n');process.exitCode=2;}
}

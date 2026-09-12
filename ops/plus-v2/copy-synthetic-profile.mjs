// Isolated diagnostic copy of this task's synthetic integration fixture.
// No main database, raw experiment or real-data policy is accepted.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,writeFileSync,mkdtempSync,chmodSync } from 'node:fs';
import { resolve,dirname,basename,join } from 'node:path';
import { pathToFileURL } from 'node:url';
export function copySyntheticProfile(source,root){
const path=resolve(source??'');
if(typeof root!=='string'||!root||basename(path)!=='platform.sqlite'||!/^plus-task-learning-[A-Za-z0-9]+$/.test(basename(dirname(path))))throw new Error('SYNTHETIC_TEST_DATABASE_REQUIRED');
const auth=readFileSync(path+'.host-auth.json'),policy=readFileSync(path+'.host-policy.json'),parsed=JSON.parse(policy);
if(!parsed.modelGovernance?.targets?.length||parsed.modelGovernance.targets.some(t=>t.policy.classification!=='SYNTHETIC'))throw new Error('SYNTHETIC_POLICY_REQUIRED');
const target=mkdtempSync(join(resolve(root),'profile-task-'));chmodSync(target,0o700);
const db=new DatabaseSync(path,{readOnly:true});
try{db.prepare('VACUUM INTO ?').run(join(target,'platform.sqlite'));}finally{db.close();}
writeFileSync(join(target,'auth.json'),auth,{mode:0o600});writeFileSync(join(target,'policy.json'),policy,{mode:0o600});
return {schema:'plus-synthetic-profile-copy-v1',target,sourceModified:false,credentialsPrinted:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  if(process.argv.length!==4)throw new Error('EXPLICIT_PROFILE_PATHS_REQUIRED');
  console.log(JSON.stringify(copySyntheticProfile(...process.argv.slice(2))));
}

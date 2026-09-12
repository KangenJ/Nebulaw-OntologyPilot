import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const root=process.cwd();
const path=process.env.MODEL_CHECKPOINT??join(root,'var','models','p36b-seed61.pt');
const expected='92579351b915f59550c56af870d14d66e554b734f7c6f9cb31a0d94b2733cd04';
if(!existsSync(path)){console.error(`MODEL_MISSING ${path}`);process.exitCode=2;}
else{const hash=createHash('sha256').update(readFileSync(path)).digest('hex');console.log(JSON.stringify({path,sha256:hash,expected,match:hash===expected},null,2));if(hash!==expected)process.exitCode=3;}

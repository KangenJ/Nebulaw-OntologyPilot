import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createNativeStorage} from './src/native-storage.mjs';
const source=resolve(process.env.LWM_NATIVE_DATABASE_PATH??'var/lwm/plus-platform.sqlite');
const target=process.argv[2]&&resolve(process.argv[2]);
if(!target||target===source||existsSync(target)||!existsSync(source))throw new Error('Supply a new backup filename; source must exist and target must not');
const storage=createNativeStorage(source);
try{await storage.backup(target);console.log('Consistent native database backup created: '+target);}finally{storage.close();}

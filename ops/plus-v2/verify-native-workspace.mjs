import {readFileSync,readdirSync,realpathSync,lstatSync,existsSync} from 'node:fs';
import {join,resolve,relative,isAbsolute,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
const fail=code=>{throw Object.assign(Error(code),{code});};
const inside=(root,path)=>{const r=relative(root,path);return r!==''&&!r.startsWith('..'+sep)&&r!=='..'&&!isAbsolute(r);};

/** Release preflight: source hashes alone cannot prove which workspace code
 * Node loads. A copied node_modules may still resolve to an older deployment.
 * This is read-only and never repairs links or touches the prior release. */
export function verifyNativeWorkspace(rootPath){
  const root=realpathSync(resolve(rootPath)),platform=join(root,'platform'),packages=new Map();
  const patterns=readFileSync(join(platform,'pnpm-workspace.yaml'),'utf8').split(/\r?\n/).map(l=>l.match(/^\s+-\s+["']?([a-z][a-z-]*)\/\*["']?\s*$/)?.[1]).filter(Boolean);
  if(!patterns.length||new Set(patterns).size!==patterns.length)fail('WORKSPACE_PATTERNS_INVALID');
  for(const pattern of patterns){const directory=join(platform,pattern);if(!existsSync(directory))continue;
    for(const item of readdirSync(directory,{withFileTypes:true})){if(!item.isDirectory())continue;const path=join(directory,item.name),file=join(path,'package.json');if(!existsSync(file))continue;
      const pkg=JSON.parse(readFileSync(file));if(typeof pkg.name!=='string'||packages.has(pkg.name))fail('WORKSPACE_PACKAGE_INVALID');
      const actual=realpathSync(path);if(!inside(platform,actual))fail('WORKSPACE_PACKAGE_OUTSIDE_RELEASE');packages.set(pkg.name,{path:actual,pkg});
    }
  }
  if(!packages.size)fail('WORKSPACE_PACKAGES_REQUIRED');const bindings=[];
  for(const [name,{path,pkg}]of packages){
    for(const dependency of Object.keys({...pkg.dependencies,...pkg.devDependencies,...pkg.optionalDependencies}).filter(n=>n.startsWith('@openfoundry/'))){
      const expected=packages.get(dependency);if(!expected)fail('WORKSPACE_DEPENDENCY_UNDECLARED');
      let actual;try{actual=realpathSync(join(path,'node_modules',dependency));}catch{fail('WORKSPACE_DEPENDENCY_MISSING');}
      if(!inside(platform,actual)||actual!==expected.path)fail('WORKSPACE_DEPENDENCY_OUTSIDE_RELEASE');
      if(JSON.parse(readFileSync(join(actual,'package.json'))).name!==dependency)fail('WORKSPACE_DEPENDENCY_IDENTITY_MISMATCH');
      bindings.push({consumer:name,dependency,path:relative(root,actual).split(sep).join('/')});
    }
  }
  if(!bindings.length)fail('WORKSPACE_BINDINGS_REQUIRED');
  return {schema:'plus-native-workspace-isolation-v1',root,packageCount:packages.size,bindingCount:bindings.length,bindings,readOnly:true,externalWorkspaceDependencies:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{
  if(process.argv.length!==3)fail('WORKSPACE_ROOT_REQUIRED');console.log(JSON.stringify(verifyNativeWorkspace(process.argv[2])));
}catch(e){console.log(JSON.stringify({schema:'plus-native-workspace-error-v1',code:e?.code?.startsWith('WORKSPACE_')?e.code:'WORKSPACE_VERIFICATION_FAILED',readOnly:true}));process.exitCode=2;}}

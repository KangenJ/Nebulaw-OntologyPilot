import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verifyNativeWorkspace} from '../../../../ops/plus-v2/verify-native-workspace.mjs';
function fixture(t,{outside=false,missing=false}={}){
 const parent=mkdtempSync(join(tmpdir(),'plus-workspace-check-')),root=join(parent,'current'),platform=join(root,'platform'),app=join(platform,'apps','app'),engine=join(platform,'packages','engine');
 t.after(()=>rmSync(parent,{recursive:true,force:true}));for(const path of [app,engine,join(app,'node_modules','@openfoundry')])mkdirSync(path,{recursive:true});
 writeFileSync(join(platform,'pnpm-workspace.yaml'),'packages:\n  - "apps/*"\n  - "packages/*"\n');
 writeFileSync(join(app,'package.json'),JSON.stringify({name:'@openfoundry/app',dependencies:{'@openfoundry/engine':'workspace:*'}}));
 writeFileSync(join(engine,'package.json'),JSON.stringify({name:'@openfoundry/engine'}));
 let target=engine;if(outside){target=join(parent,'prior','engine');mkdirSync(target,{recursive:true});writeFileSync(join(target,'package.json'),JSON.stringify({name:'@openfoundry/engine'}));}
 if(!missing)symlinkSync(target,join(app,'node_modules','@openfoundry','engine'),process.platform==='win32'?'junction':'dir');return {root,engine};
}
test('release verifier accepts only links resolving to the same release workspace package',t=>{const f=fixture(t),result=verifyNativeWorkspace(f.root);assert.equal(result.packageCount,2);assert.equal(result.bindingCount,1);assert.equal(result.externalWorkspaceDependencies,false);});
test('release verifier refuses copied absolute links to a previous release even with the same package name and source bytes',t=>{const f=fixture(t,{outside:true});assert.throws(()=>verifyNativeWorkspace(f.root),/WORKSPACE_DEPENDENCY_OUTSIDE_RELEASE/);});
test('release verifier refuses missing dependencies instead of falling back to ancestor node_modules',t=>{const f=fixture(t,{missing:true});assert.throws(()=>verifyNativeWorkspace(f.root),/WORKSPACE_DEPENDENCY_MISSING/);});
test('release verifier rejects dependency identity changes',t=>{const f=fixture(t);writeFileSync(join(f.engine,'package.json'),JSON.stringify({name:'@openfoundry/other'}));assert.throws(()=>verifyNativeWorkspace(f.root),/WORKSPACE_DEPENDENCY_UNDECLARED/);});

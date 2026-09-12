// Read-only T01 evidence against the actual pre-migration native domain packs.
// A future approved schema migration will retire this specific baseline probe.
import assert from 'node:assert/strict';
import {writeFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {loadDomainPacks} from '../../platform/packages/api/dist/schema-loader.js';
import {compileDefinition} from '../../platform/packages/plus-contracts/dist/index.js';
import {fixture} from '../../platform/packages/plus-contracts/tests/fixture.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const loaded=await loadDomainPacks(resolve(root,'platform/domain-packs'),['lwm-demo','lwm-plus']);
assert.ok(loaded.parsed.objectTypes.some(t=>t.name==='InvestigationTask'));
assert.ok(loaded.parsed.objectTypes.find(t=>t.name==='InvestigationTask').fields.some(f=>f.name==='status'));
assert.equal(loaded.manifestRegistry.get('NativeReviewTransition'),undefined);
// Same explicit gate as native-dev.mjs, in this isolated read-only process only.
process.env.LWM_NATIVE_ENABLED='true';
assert.ok(loaded.manifestRegistry.get('NativeReviewTransition'));
const f=fixture({root:'InvestigationTask',signal:'Observation'});
f.context.parsed=loaded.parsed;f.context.spiSchema=loaded.spiSchema;f.context.manifestRegistry=loaded.manifestRegistry;
assert.throws(()=>compileDefinition(f.definition,f.context),e=>e.code==='FIELD_NOT_FOUND');
const report={passed:true,checkedAt:new Date().toISOString(),mode:'pre-migration-read-only',checks:['real loadDomainPacks supplies full ontology and native manifest registry','native manifests remain gated in generic entrypoint','InvestigationTask workflow status exists','unpublished physical state binding rejected; no inference from workflow name'],objects:loaded.parsed.objectTypes.length,actions:loaded.parsed.actionTypes.length,changedSchema:false};
mkdirSync(resolve(root,'var/plus-v2'),{recursive:true});
writeFileSync(resolve(root,'var/plus-v2/t01-native-contract-check.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));

import test from 'node:test';
import assert from 'node:assert/strict';
import {suggestOptionalProperties} from '../public-plus/ontology-suggestions.js';
const catalog={bundle:{contentHash:'current-ontology',parsed:{objectTypes:[{name:'WorkItem',fields:[{name:'id'},{name:'title'}]},{name:'PlusMetadata',fields:[]}]}}};
const suggest=rows=>suggestOptionalProperties({rows,objectType:'WorkItem',catalog});
test('new samples produce deterministic optional primitive suggestions without sample value disclosure',()=>{
  const rows=[{title:'private title',effort:3,verified:false,channel:'secret channel'},{effort:null,verified:true},{effort:4}];
  const r=suggest(rows);assert.equal(r.method,'DETERMINISTIC_SAMPLE_TYPE_INFERENCE');
  assert.deepEqual(r.suggestions.map(s=>[s.field,s.valueType,s.nullable]),[['channel','String',true],['effort','Int',true],['verified','Boolean',true]]);
  assert.deepEqual(r.suggestions[1].evidence,{rows:3,present:3,missing:0,nulls:1});assert.deepEqual(r.known,['title']);
  assert.doesNotMatch(JSON.stringify(r),/private title|secret channel/);assert.equal(r.modelTrained,false);assert.equal(r.automaticallyPublished,false);
  assert.deepEqual(suggest(rows.map(r=>Object.fromEntries(Object.entries(r).reverse()))),r);
});
test('mixed/null/nested/reference values are explicit unresolved items rather than invented ontology or coerced scalars',()=>{
  const r=suggest([{otherId:'r1',unknown:null,mixed:'a',fraction:1.5,nested:{name:'private'},items:[1],oversize:1e20},{unknown:null,mixed:1}]);
  assert.equal(r.suggestions.length,0);assert.equal(r.unresolved.find(v=>v.field==='otherId').reason,'POSSIBLE_REFERENCE_REQUIRES_EXPLICIT_RELATION');
  assert.equal(r.unresolved.find(v=>v.field==='mixed').reason,'MIXED_TYPES_REQUIRE_REVIEW');assert.equal(r.unresolved.find(v=>v.field==='nested').reason,'OBJECT_OR_RELATION_REQUIRES_EXPLICIT_MODEL');
  assert.doesNotMatch(JSON.stringify(r),/r1|private/);
});
test('fresh sample names and types change suggestions without any legal constants or fixed answers',()=>{
  assert.deepEqual(suggest([{temperatureBand:'cold',flag:false}]).suggestions.map(s=>s.field),['flag','temperatureBand']);
  const renamed={bundle:{...catalog.bundle,parsed:{objectTypes:[{name:'Machine',fields:[]}]}}};
  const r=suggestOptionalProperties({rows:[{stage:'A'},{stage:'B'},{stage:'C'}],objectType:'Machine',catalog:renamed});
  assert.equal(r.objectType,'Machine');assert.deepEqual(r.suggestions.map(s=>[s.field,s.valueType]),[['stage','String']]);
});
test('bounded input, reserved keys and native metadata targets cannot generate unsafe suggestions',()=>{
  for(const rows of [[],Array(51).fill({}),[null],[[]],[1],[Object.create(null)],[Object.fromEntries(Array.from({length:101},(_,i)=>['field'+i,1]))]])assert.throws(()=>suggest(rows),/SUGGESTION_/);
  assert.throws(()=>suggestOptionalProperties({rows:[{a:1}],objectType:'PlusMetadata',catalog}),/CURRENT_ONTOLOGY/);
  const r=suggest(JSON.parse('[{"__proto__":"x","constructor":"x","invalid-name":1}]'));assert.equal(r.suggestions.length,0);assert.equal(r.unresolved.length,3);
});

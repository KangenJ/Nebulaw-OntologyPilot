import test from 'node:test';
import assert from 'node:assert/strict';
import {suggestBusinessStructure} from '../public-plus/ontology-suggestions.js';
const catalog={bundle:{contentHash:'current',parsed:{objectTypes:[{name:'Matter',fields:[{name:'id'}]},{name:'PlusOutbox',fields:[]}]}}};
test('new collection proposes optional object fields and explicit unverified reference, never values or inferred cardinality',()=>{
  const result=suggestBusinessStructure({catalog,tables:{Deliverable:[{title:'private-content',matterId:'private-id',done:false},{title:'private-other',matterId:'private-id',done:true}]}});
  assert.deepEqual(result.objects[0].properties.map(p=>[p.name,p.valueType]),[['done','Boolean'],['title','String']]);
  assert.equal(result.links[0].from,'Deliverable');assert.equal(result.links[0].to,'Matter');assert.equal(result.links[0].cardinality,null);
  assert.equal(result.links[0].endpointsPublished,false);assert.equal(result.identityMatchesVerified,false);
  assert.doesNotMatch(JSON.stringify(result),/private-content|private-id|private-other/);
  const installed=structuredClone(catalog);installed.bundle.parsed.objectTypes.push({name:'Deliverable',fields:[{name:'id'},{name:'title'},{name:'done'}]});
  const second=suggestBusinessStructure({catalog:installed,tables:{Deliverable:[{title:'new',matterId:'ref'}]}});
  assert.equal(second.objects.length,0);assert.equal(second.links[0].endpointsPublished,true);
});
test('bounded structure suggestions reject control types and keep unknown or ambiguous structure unresolved',()=>{
  for(const tables of [{},[],{PlusModel:[{x:true}]},{'bad name':[{x:true}]},{One:[]},{One:Array.from({length:51},()=>({x:true}))}])assert.throws(()=>suggestBusinessStructure({catalog,tables}));
  const result=suggestBusinessStructure({catalog,tables:{Novel:[{title:'a',nested:{value:2},unknownId:'x',number:1.5}]}});
  assert.deepEqual(result.objects[0].properties.map(p=>p.name),['title']);assert.equal(result.links.length,0);assert.equal(result.unresolved.length,3);
  assert.equal(result.automaticallyPublished,false);assert.equal(result.permissionsGranted,false);
});

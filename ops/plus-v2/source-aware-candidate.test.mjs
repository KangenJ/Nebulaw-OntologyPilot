import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseByValidation,candidateFactory} from './source-aware-candidate.mjs';
test('validation policy rejects unsupported or regressing candidates',()=>{
  const frozen={key:'frozen',coverage:1,nll:.5};
  assert.equal(chooseByValidation([frozen,{key:'recent',coverage:.5,nll:.1}]).key,'frozen');
  assert.equal(chooseByValidation([frozen,{key:'recent',coverage:1,nll:.49}]).key,'frozen');
  assert.equal(chooseByValidation([frozen,{key:'recent',coverage:1,nll:.6}]).key,'frozen');
  assert.deepEqual(chooseByValidation([frozen,{key:'recent',coverage:1,nll:.4}]),{key:'recent',status:'CANDIDATE_FOR_REVIEW_NOT_PUBLICATION'});
  assert.equal(chooseByValidation([{key:'frozen',coverage:0,nll:null}]).key,null);
});
test('ties are deterministic, unsupported frozen model cannot block a supported candidate',()=>{
  assert.equal(chooseByValidation([{key:'frozen',coverage:0,nll:null},{key:'recent',coverage:1,nll:.4},{key:'cumulative',coverage:1,nll:.4}]).key,'cumulative');
});
test('source-specific fit uses both channels and is sensitive to source identity',{skip:!process.env.PLUS_BENCHMARK_ROOT},async()=>{
  const {fit}=await candidateFactory(process.env.PLUS_BENCHMARK_ROOT);
  const rows=Array.from({length:3},(_,y)=>({id:'unit-'+y,frames:Array.from({length:6},()=>({y,reports:[y,(y+1)%3]}))}));
  const source=fit(rows,'unit-source'),pooled=fit(rows,'unit-pooled',{separate:false});
  const original=source.predict(rows[0]),swapped=source.predict({id:'swapped',frames:rows[0].frames.map(f=>({...f,reports:[...f.reports].reverse()}))});
  assert.equal(source.E.length,2);assert.notDeepEqual(source.E[0],source.E[1]);assert.ok(original[0]>.9);assert.ok(Math.abs(original[0]-swapped[0])>.1);
  assert.notEqual(source.compiledHash,pooled.compiledHash);assert.deepEqual(original,source.predict(rows[0]));
  assert.throws(()=>fit([rows[0],rows[0]],'duplicate'));
  assert.throws(()=>source.predict({id:'invalid-report',frames:[{y:0,reports:[4,0]}]}));
});

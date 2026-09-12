import test from 'node:test';
import assert from 'node:assert/strict';
import {mockMarkup,mockComparison} from '../public-plus/native-journey-mock.js';
test('all mock stages clearly label fiction and cannot mount native forms',()=>{
  for(let step=0;step<7;step++){
    const html=mockMarkup(step);
    assert.match(html,/MOCK · 虚构业务数据 · 无原生写入/);
    assert.match(html,/退出演练，返回真实业务/);
    assert.doesNotMatch(html,/id="flow-tool-slot"|data-journey-go|id="journey-load"/);
    assert.equal((html.match(/data-mock-step=/g)||[]).length,7);
  }
});
test('teaching formula recomputes assumptions including break-even and rejects invalid inputs',()=>{
  assert.equal(mockComparison(.8).noCheck,3000);
  assert.ok(Math.abs(mockComparison(.8).check-1200)<1e-9);
  assert.equal(mockComparison(.2).check,3000);
  assert.equal(mockComparison(0).check,3600);
  assert.equal(mockComparison(1).check,600);
  for(const p of [NaN,Infinity,-1,2,'0.8'])assert.throws(()=>mockComparison(p));
});

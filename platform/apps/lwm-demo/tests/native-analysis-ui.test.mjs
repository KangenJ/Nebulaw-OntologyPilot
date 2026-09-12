import test from 'node:test';
import assert from 'node:assert/strict';
import {parseNativeAnalysisText} from '../public-plus/native-analysis-ui.js';
import {analysisUiFixture} from './native-analysis-ui-fixture.mjs';

const principal={id:'reader',tenantId:'synthetic',roles:['viewer']},root={type:'WorkItem',id:'root',version:1},target={type:'WorkItem',id:'target',version:2};
const field=(name,type)=>({name,type:{name:type,isList:false},directives:[]});
const catalog={bundle:{parsed:{objectTypes:[{name:'WorkItem',fields:[field('title','String'),field('amount','Float')]}],enums:[],linkTypes:[{name:'Relation',from:'WorkItem',to:'WorkItem'}]}}};
const answer=()=>({schema:'plus-object-analysis-v1',root,targetType:'WorkItem',linkType:'Relation',direction:'outbound',field:'title',mode:'GROUP_COUNT',scope:'AUTHORIZED_ONE_HOP',countUnit:'DISTINCT_OBJECT',objectCount:1,visibleLinkCount:1,missingCount:0,nullCount:0,
  groups:[{value:{kind:'VALUE',value:'<img src=x>'},count:1,members:[target]}],numeric:null,sources:{objects:[target],links:[{type:'Relation',id:'edge',version:1,from:{type:'WorkItem',id:'root'},to:{type:'WorkItem',id:'target'}}]},readOnly:true,snapshotConsistent:true,predictionReady:false,executionAuthorized:false});
const fixture=options=>analysisUiFixture({principal,detail:{reference:root},catalog,...options});

test('shipped analysis handlers parse only allowlisted grammar, query explicitly, escape values and drill into native source',async()=>{
  const calls=[],opened=[],f=fixture({api:async(path)=>{calls.push(path);return answer();},onOpenObject:async r=>opened.push(r)});
  f.parse('按 title 分组');assert.equal(calls.length,0);f.submit();await f.settle();assert.equal(f.error(),undefined);
  assert.equal(calls[0],'/objects/WorkItem/root/analysis?linkType=Relation&direction=outbound&field=title&mode=GROUP_COUNT');
  assert.match(f.html(),/&lt;img src=x&gt;/);assert.doesNotMatch(f.html(),/<img/);f.drill(0);await f.settle();assert.deepEqual(opened,[target]);
  f.parse('帮我删除数据');assert.equal(calls.length,1);assert.doesNotMatch(f.html(),/原生分析结果/);assert.match(f.html(),/仅支持/);
  assert.deepEqual(parseNativeAnalysisText('汇总 amount',[{name:'amount',modes:['NUMERIC_SUMMARY']}]),{field:'amount',mode:'NUMERIC_SUMMARY'});
  assert.throws(()=>parseNativeAnalysisText('按 secret 分组',[{name:'title',modes:['GROUP_COUNT']}]));
});
test('shipped analysis discards malformed membership, edge provenance and stale root versions',async()=>{
  for(const mutate of [v=>v.sources.links[0].from.id='other',v=>v.sources.links=[],v=>v.groups[0].count=2,v=>v.root={...root,version:2},v=>v.predictionReady=true]){
    const v=structuredClone(answer());mutate(v);const f=fixture({api:async()=>v});f.submit();await f.settle();assert.ok(f.error());assert.doesNotMatch(f.html(),/原生分析结果/);
  }
});
test('shipped analysis clears previous result on failure and discards late response after actor or root change',async()=>{
  let deny=false;const f=fixture({api:async()=>{if(deny)throw Error('FORBIDDEN');return answer();}});f.submit();await f.settle();assert.match(f.html(),/原生分析结果/);
  deny=true;f.submit();await f.settle();assert.doesNotMatch(f.html(),/原生分析结果/);
  for(const change of [f=>f.setActor({...principal,id:'second'}),f=>f.setDetail({reference:{...root,id:'second'}})]){
    let release;const delayed=fixture({api:()=>new Promise(resolve=>release=resolve)});delayed.submit();change(delayed);delayed.ui.render();release(answer());await delayed.settle();assert.doesNotMatch(delayed.html(),/原生分析结果/);
  }
});
test('shipped numeric analysis displays computed zero distinctly from no values',async()=>{
  const v=answer();Object.assign(v,{field:'amount',mode:'NUMERIC_SUMMARY',groups:null,numeric:{count:1,sum:0,mean:0,min:0,max:0}});
  const f=fixture({api:async()=>v});f.choose('amount');f.submit();await f.settle();assert.equal(f.error(),undefined);assert.match(f.html(),/<dt>总和<\/dt><dd>0<\/dd>/);
});

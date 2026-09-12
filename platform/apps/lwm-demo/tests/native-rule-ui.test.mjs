import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeRuleWorkbench,prepareNativeRuleProposal,nativeRuleSpecificationHash} from '../public-plus/native-rule-ui.js';
const options=()=>({schema:'plus-rule-authoring-options-v1',key:'rule.one',definitionKey:'machine',definitionHash:'a'.repeat(64),canDraft:true,canReview:true,readOnly:true,predictionReady:false,executionAuthorized:false,
  modules:[{key:'recommend',inputs:['priority'],outputs:['recommendation']}],variables:[{key:'priority',valueType:'Int',support:[1,2,3,'UNKNOWN'],unknownValues:['UNKNOWN']},{key:'recommendation',role:'RULE_DERIVED',valueType:'String',support:['WAIT','ESCALATE'],unknownValues:[]}],
  sources:[{reference:{id:'source',version:1,hash:'b'.repeat(64)},moduleKeys:['recommend'],fields:{title:'<script>source</script>'}}],revisions:[]});
const values=()=>({'0.source':'0','0.mode':'ALL','0.input.0.op':'GE','0.input.0.value':'1','0.output.0':'1'});
function fixture(){
  const o=options(),nodes=new Map(),$=key=>{if(!nodes.has(key))nodes.set(key,{value:'',disabled:false,innerHTML:''});return nodes.get(key);};
  let busy=false,last=Promise.resolve(),error,actor='author',lose=false,record,hold,release;const calls=[];
  const api=async(path,epoch,body,key)=>{calls.push({path,body:structuredClone(body),key});if(hold){hold=false;await new Promise(r=>release=r);}
    if(path.endsWith('/options'))return {schema:'plus-rule-workbench-index-v1',items:[{key:o.key,definitionKeys:[o.definitionKey]}],readOnly:true,predictionReady:false};
    if(path.endsWith('/authoring-options'))return structuredClone(o);
    if(path==='/learning/rule-specifications'){record={_id:'draft',_version:1,ruleKey:o.key,status:'DRAFT',submittedBy:actor,definitionKey:o.definitionKey,definitionHash:o.definitionHash,specificationHash:await nativeRuleSpecificationHash(body.specification)};o.revisions=[{id:'draft',version:1,key:o.key,revision:1,status:'DRAFT'}];if(lose){lose=false;throw Error('lost response');}return {id:'draft',key:o.key,predictionReady:false};}
    if(path.endsWith('/revisions'))return structuredClone(o.revisions);
    if(path.endsWith('/decision'))return {...record,id:record._id,key:o.key,version:record._version,readOnly:true,qualification:'NOT_CHECKED',predictionReady:false};
    if(path.endsWith('/draft'))return {record:structuredClone(record),predictionReady:false,executionAuthorized:false};
    throw Error('Unexpected API '+path);
  };
  const run=fn=>{busy=true;last=Promise.resolve().then(()=>fn(1)).catch(e=>error=e).finally(()=>busy=false);return last;};
  const ui=createNativeRuleWorkbench({document:{querySelector:$},api,run,isBusy:()=>busy,getPrincipal:()=>({id:actor})});ui.render();
  const click=async id=>{$('#'+id).onclick();await last;};
  const load=async()=>{await click('rules-discover');$('#rules-purpose').value='0';$('#rules-purpose').onchange();await click('rules-load');};
  const preview=async()=>{for(const [k,v]of Object.entries(values()))$('[id="'+k+'"]').value=v;$('#rules-form').onsubmit({preventDefault(){}});await last;};
  return {$,ui,click,load,preview,calls,options:o,html:()=>$('#rule-workbench').innerHTML,error:()=>error,actor:v=>actor=v,lose:()=>lose=true,record:()=>record,hold:()=>hold=true,release:()=>release(),settle:()=>last};
}
test('typed rule form maps current support values and refuses unknown, invalid operators and unbound sources',()=>{
  const o=options(),v=values(),before=structuredClone(o),p=prepareNativeRuleProposal(o,v,1);assert.equal(p.specification.rules[0].when.right.value,2);assert.deepEqual(p.specification.rules[0].outputs,{recommendation:'ESCALATE'});assert.deepEqual(o,before);
  for(const patch of [{'0.source':'2'},{'0.mode':'X'},{'0.input.0.value':'3'},{'0.input.0.op':'EXEC'}])assert.throws(()=>prepareNativeRuleProposal(o,{...v,...patch},1));
  const wrong=options();wrong.sources[0].moduleKeys=[];assert.throws(()=>prepareNativeRuleProposal(wrong,v,1));
  const constant=options();constant.modules[0].inputs=[];assert.throws(()=>prepareNativeRuleProposal(constant,v,1));
  assert.throws(()=>prepareNativeRuleProposal({...o,canDraft:false},v,1));
});
test('rule hashes are stable across dictionary and module order, reject non-finite data and change with typed outputs',async()=>{
  const spec=prepareNativeRuleProposal(options(),values(),1).specification;
  const two={...spec,rules:[{...spec.rules[0],moduleKey:'z'},spec.rules[0]]},reordered={rules:[...two.rules].reverse(),definitionHash:two.definitionHash,schema:two.schema};
  assert.equal(await nativeRuleSpecificationHash(two),await nativeRuleSpecificationHash(reordered));
  const changed=structuredClone(spec);changed.rules[0].outputs.recommendation='WAIT';assert.notEqual(await nativeRuleSpecificationHash(spec),await nativeRuleSpecificationHash(changed));
  await assert.rejects(()=>nativeRuleSpecificationHash({...spec,bad:NaN}));
});
test('lost native draft response locks replacement and recovers exact original metadata without a second write',async()=>{
  const f=fixture();await f.load();assert.match(f.html(),/&lt;script&gt;/);assert.doesNotMatch(f.html(),/<script>/);await f.preview();f.lose();await f.click('rules-save');assert.match(f.error().message,/lost response/);
  assert.match(f.html(),/结果待查证/);await f.preview();await f.click('rules-recover');assert.match(f.html(),/已核对原生修订/);assert.equal(f.calls.filter(c=>c.path==='/learning/rule-specifications').length,1);
  f.$('#rules-revision').value='draft';await f.click('rules-read');assert.match(f.html(),/id="rules-approve" disabled/);
});
test('mismatched historical receipt stays unresolved and a new identity cannot reuse original request',async()=>{
  const f=fixture();await f.load();await f.preview();f.lose();await f.click('rules-save');f.record().specificationHash='0'.repeat(64);await f.click('rules-recover');assert.match(f.error().message,/RULE_REVISION_CONFLICT/);assert.match(f.html(),/结果待查证/);
  f.actor('other');await f.click('rules-retry');assert.match(f.error().message,/原身份/);assert.equal(f.calls.filter(c=>c.path==='/learning/rule-specifications').length,1);
});
test('reset discards late discovery and refreshed revision cannot enable a decision from stale DRAFT selection',async()=>{
  const f=fixture();f.hold();f.$('#rules-discover').onclick();await new Promise(r=>setImmediate(r));f.ui.reset();f.ui.render();f.release();await f.settle();assert.equal(f.error().discarded,true);assert.doesNotMatch(f.html(),/rules-purpose/);
  await f.load();await f.preview();await f.click('rules-save');f.actor('owner');f.record().status='APPROVED';f.record()._version=2;f.$('#rules-revision').value='draft';await f.click('rules-read');
  assert.match(f.html(),/id="rules-reject" disabled/,'Fresh non-DRAFT native record disables both decisions');
});

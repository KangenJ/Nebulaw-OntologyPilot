import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeDefinitionWorkbench} from '../public-plus/native-definition-ui.js';

const definition={schema:'plus-mechanism-v1',key:'machine.state',revision:1,title:'Machine <candidate>',rootType:'Machine',scope:{key:'synthetic',policyRef:'scope'},variables:[{key:'state',role:'LATENT',source:{objectType:'Machine',field:'state'},valueType:'State',unit:'1',support:['GOOD','BAD','BROKEN'],unknownValues:['UNKNOWN'],time:{eventTimeField:'at',receivedTimeField:'received'},verification:{mode:'GOLD',policyRef:'independent'},missingPolicy:{absent:'UNOBSERVED',null:'MISSING',withdrawn:'REVOKED'},accessPolicyRef:'private',transform:{kind:'IDENTITY'}}],modules:[],actions:[],budget:{mechanisms:3,horizon:4,alternatives:2,branchDepth:1},utility:{decisions:['GOOD','BAD','BROKEN'],losses:[[0,1,2],[1,0,1],[2,1,0]],verificationCost:1,minimumDifference:0.1}};
function fixture(candidate=definition){
  const nodes=new Map(),buttons=[],$=s=>{if(!nodes.has(s))nodes.set(s,{value:'',innerHTML:'',disabled:false});return nodes.get(s);};
  let principal={id:'author',roles:['data_reviewer']},busy=false,last=Promise.resolve(),error,lose=false,refuse=false,late,rows=[],body;
  const calls=[],wrap=d=>({schema:'plus-definition-preview-v1',definition:structuredClone(d),definitionHash:'a'.repeat(64),compiledHash:'b'.repeat(64),ontologyHash:'c'.repeat(64),readOnly:true,predictionReady:false,executionAuthorized:false});
  const api=async(path,epoch,input)=>{calls.push({path,body:structuredClone(input)});
    if(path==='/definition-candidates'){if(late)return new Promise(r=>late=r);return {items:[{key:candidate.key,title:candidate.title,rootType:'Machine'}],readOnly:true,predictionReady:false};}
    if(path.endsWith('/candidate'))return {...wrap(candidate),schema:'plus-definition-candidate-v1'};
    if(path.endsWith('/previews'))return wrap(input);
    if(path.endsWith('/revisions')&&input){if(refuse)throw Object.assign(Error('DEFINITION_PREVIEW_STALE'),{status:409});body=structuredClone(input);const row={_id:'native-draft',_version:1,revision:1,definitionKey:definition.key,submittedBy:'author',status:'DRAFT',definitionHash:'a'.repeat(64),compiledHash:'b'.repeat(64)};rows=[row];if(lose){lose=false;throw Object.assign(Error('response lost'),{status:502});}return structuredClone(row);}
    if(path.endsWith('/revisions'))return structuredClone(rows);
    if(path.endsWith('/validate')){rows[0].status='VALIDATED';rows[0]._version++;return structuredClone(rows[0]);}
    if(path.endsWith('/review')){rows[0].status=input.decision==='APPROVE'?'PUBLISHED':'REJECTED';rows[0].approvedBy=principal.id;rows[0]._version++;return structuredClone(rows[0]);}
    if(path.endsWith('/native-draft'))return {record:structuredClone(rows[0]),compiled:{definition:structuredClone(body.definition)},compatibility:{compatible:true},predictionReady:false};assert.fail(path);
  };
  const run=fn=>{if(busy)return;busy=true;last=fn(1).catch(e=>error=e).finally(()=>busy=false);return last;};let ui;
  const render=()=>{$('#content').innerHTML=ui.markup();buttons.length=0;for(const m of $('#content').innerHTML.matchAll(/data-definition-revision="([^"]+)"/g))buttons.push({dataset:{definitionRevision:m[1]}});ui.bind();};
  ui=createNativeDefinitionWorkbench({document:{querySelector:$,querySelectorAll:s=>s==='[data-definition-revision]'?buttons:[]},api,run,isBusy:()=>busy,getPrincipal:()=>principal,getCatalog:()=>({bundle:{parsed:{objectTypes:[{name:'Machine',fields:[{name:'state'},{name:'at'},{name:'received'}]}]}}}),onRender:render});render();
  const discover=async()=>{$('#definition-candidates-refresh').onclick();await last;$('#definition-candidate-key').value=definition.key;$('#definition-candidate-key').onchange();$('#definition-candidate-load').onclick();await last;};
  return {$,ui,calls,buttons,discover,settle:()=>last,error:()=>error,rows:()=>rows,body:()=>body,lose:()=>lose=true,refuse:()=>refuse=true,owner:()=>{principal={id:'owner',roles:['model_owner']};ui.reset();render();},late:()=>late=true,release:v=>late(v)};
}
test('nonlegal typed candidate form edits actual fields, preflights then saves the exact normalized preview and independently publishes',async()=>{
  const f=fixture();assert.equal(f.calls.length,0);await f.discover();assert.match(f.$('#content').innerHTML,/Machine &lt;candidate&gt;/);
  f.$('#definition-title').value='Reviewed machine';f.$('#definition-title').oninput();f.$('#definition-budget-horizon').value='3';f.$('#definition-budget-horizon').oninput();
  f.$('#definition-edit-form').onsubmit({preventDefault(){}});await f.settle();assert.equal(f.calls.at(-1).body.title,'Reviewed machine');assert.equal(f.calls.at(-1).body.budget.horizon,3);assert.deepEqual(f.calls.at(-1).body.variables[0].support,['GOOD','BAD','BROKEN']);
  assert.equal(f.rows().length,0);f.$('#definition-save').onclick();await f.settle();assert.equal(f.rows()[0].status,'DRAFT');assert.equal(f.body().expectedCompiledHash,'b'.repeat(64));assert.equal(f.body().definition.title,'Reviewed machine');assert.equal(Object.hasOwn(f.body(),'policy'),false);
  f.$('#definition-validate').onclick();await f.settle();const n=f.calls.length;f.$('#definition-approve').onclick();await f.settle();assert.equal(f.calls.length,n,'author cannot approve');
  f.owner();await f.discover();f.buttons[0].onclick();await f.settle();f.$('#definition-approve').onclick();await f.settle();assert.equal(f.rows()[0].status,'PUBLISHED');
});
test('response loss locks edits and recovers the original committed draft without issuing another mutation',async()=>{
  const f=fixture();await f.discover();f.$('#definition-edit-form').onsubmit({preventDefault(){}});await f.settle();f.lose();f.$('#definition-save').onclick();await f.settle();assert.match(f.error().message,/response lost/);assert.match(f.$('#content').innerHTML,/definition-recover/);
  const n=f.calls.length;f.$('#definition-candidates-refresh').onclick();await f.settle();assert.equal(f.calls.length,n);f.$('#definition-recover').onclick();await f.settle();assert.equal(f.calls.filter(c=>c.path.endsWith('/revisions')&&c.body).length,1);assert.doesNotMatch(f.$('#content').innerHTML,/id="definition-recover"/);
});
test('form edits invalidate preview; negative budgets are rejected before HTTP; session reset discards late candidate discovery',async()=>{
  const f=fixture();await f.discover();f.$('#definition-edit-form').onsubmit({preventDefault(){}});await f.settle();f.$('#definition-budget-horizon').value='-1';f.$('#definition-budget-horizon').oninput();assert.equal(f.$('#definition-preview').innerHTML,'');const n=f.calls.length;f.$('#definition-edit-form').onsubmit({preventDefault(){}});await f.settle();assert.equal(f.calls.length,n);
  const late=fixture();late.late();late.$('#definition-candidates-refresh').onclick();late.ui.reset();late.release({items:[{key:'secret',title:'private'}],readOnly:true,predictionReady:false});await late.settle();assert.doesNotMatch(late.ui.markup(),/private|secret/);
});
test('rectangular utility matrix labels decisions against target state support, not other decisions',async()=>{
  const candidate=structuredClone(definition);candidate.utility.target='state';candidate.utility.decisions=['INSPECT','WAIT'];candidate.utility.losses=[[0,1,2],[2,1,0]];
  const f=fixture(candidate);await f.discover();assert.match(f.$('#content').innerHTML,/INSPECT → BROKEN/);assert.match(f.$('#content').innerHTML,/WAIT → GOOD/);
  f.$('#definition-edit-form').onsubmit({preventDefault(){}});await f.settle();assert.deepEqual(f.calls.at(-1).body.utility.losses,[[0,1,2],[2,1,0]]);
});
test('a definite stale-preview refusal can return to editing only after querying that no revision was committed',async()=>{
  const f=fixture();await f.discover();f.$('#definition-edit-form').onsubmit({preventDefault(){}});await f.settle();f.refuse();f.$('#definition-save').onclick();await f.settle();assert.doesNotMatch(f.$('#content').innerHTML,/id="definition-return-edit"/);
  f.$('#definition-recover').onclick();await f.settle();assert.match(f.$('#content').innerHTML,/id="definition-return-edit"/);f.$('#definition-return-edit').onclick();assert.doesNotMatch(f.$('#content').innerHTML,/id="definition-recover"/);assert.equal(f.rows().length,0);
});

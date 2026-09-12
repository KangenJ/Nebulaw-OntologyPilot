import { randomUUID, createHash } from 'node:crypto';
import { dynamicsRequest } from './dynamics-client.mjs';
import { createNativeLearning, learningRoles } from './native-learning.mjs';
import { parseOdl } from '../../../packages/odl/dist/index.js';
import { assertReader } from './auth.mjs';
import { createLegacyProjection } from './legacy-projection.mjs';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const plusRoles = Object.freeze({ importBatch:'investigator', draftOntology:'data_reviewer', publishOntology:'model_owner',
  simulate:'investigator', propose:'investigator', recordOutcome:'investigator', qualifyOutcome:'data_reviewer', withdrawOutcome:'data_reviewer',
  migrateLegacy:'investigator', ...learningRoles });
const issue = (code,message,status=400)=>Object.assign(new Error(message),{code,status});
const requiredText=(value,name,max=20000)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw issue('INVALID_INPUT',name+' requires nonempty bounded text');return value;};
const literal=value=>value===null?'null':typeof value==='number'||typeof value==='boolean'?String(value):"'"+String(value)+"'";
const properties=value=>Object.fromEntries(Object.entries(value).map(([k,v])=>[k,literal(v)]));
const create=(type,value,as)=>({type:'createObject',objectType:type,properties:properties(value),...(as?{as}:{})});
const update=(target,value)=>({type:'updateObject',target,set:properties(value)});
const link=(type,from,to)=>({type:'createLink',linkType:type,from,to,properties:{linkedAt:'now'}});
const parse=value=>JSON.parse(value);
const allowedStates=['EVIDENCE_COMPLETE','NOTICE_RECEIVED','CLAIM_RECEIVED'];

export async function createPlusWorkbenches(deps) {
  const {storage,schema,actionExecutor,auditStore}=deps;
  const ctx={tenantId:'lwm-demo',traceId:'plus-bootstrap'};
  const all=async type=>{const page=await storage.queryObjects(ctx,type,{and:[]},{limit:1000});if(page.hasNextPage)throw issue('DEMO_LIMIT','Demo collection exceeds 1000 objects',409);return page.items;};
  const get=async(type,id)=>{if(typeof id!=='string')throw issue('INVALID_ID','Object ID required');const item=await storage.getObject(ctx,type,id);if(!item)throw issue('NOT_FOUND',type+' not found',404);return item;};
  if(!(await all('WorkspaceControl')).length)await storage.createObject(ctx,'WorkspaceControl',{key:'plus',updatedAt:new Date().toISOString()});

  // Published additive definitions are stored in the native ontology itself.
  // Legacy projection is repaired only by explicit publication or bootstrap.
  // Reads detect drift but never modify either SPI or in-memory ODL.
  async function reconcileOntology({apply=false}={}) {
    const drafts=(await all('OntologyDraft')).filter(d=>d.status==='APPROVED');
    const current=await storage.getSchema(ctx), next=structuredClone(current);
    let changed=false;const parsedAdditions=[];
    for(const draft of drafts){
      const definition=parse(draft.definitionJson);
      const target=next.objectTypes.find(t=>t.name===definition.type);
      const parsedType=schema.objectTypes.find(t=>t.name===definition.type);
      if(!target||!parsedType)throw issue('ONTOLOGY_PROJECTION_STALE','Approved legacy type is missing',503);
      for(const field of definition.fields){
        const existing=target.properties.find(p=>p.name===field.name),parsedExisting=parsedType.fields.find(p=>p.name===field.name);
        if((existing&&existing.type!==field.type)||(parsedExisting&&parsedExisting.type.name!==field.type))throw issue('ONTOLOGY_PROJECTION_STALE','Approved legacy field type differs from installed definition',503);
        if(!target.properties.some(p=>p.name===field.name)){target.properties.push({name:field.name,type:field.type,required:false});changed=true;}
        if(!parsedType.fields.some(p=>p.name===field.name))parsedAdditions.push({parsedType,field});
      }
    }
    if((changed||parsedAdditions.length)&&!apply)throw issue('ONTOLOGY_PROJECTION_STALE','Explicit ontology publication or recovery is required; reads do not repair definitions',503);
    if(apply&&(changed||parsedAdditions.length)&&current.objectTypes.some(t=>t.name==='PlusOntologyHead')){
      const heads=await all('PlusOntologyHead');
      if(heads.length)throw issue('ONTOLOGY_CATALOG_OWNS_PUBLICATION','Persistent v2 catalog owns ontology publication',409);
    }
    if(changed){next.version=current.version+1;await storage.applySchema(ctx,next);}
    for(const {parsedType,field}of parsedAdditions)parsedType.fields.push({name:field.name,type:{name:field.type,nonNull:false,isList:false,listElementNonNull:false},directives:[]});
    return {version:changed?next.version:current.version,approvedDrafts:drafts.map(d=>d._id)};
  }
  await reconcileOntology({apply:true});

  const learning=await createNativeLearning({all,get,storage,ctx});
  async function read(principal){assertReader(principal);const ontology=await reconcileOntology();const model=await dynamicsRequest('/v1/status').catch(e=>({ready:false,error:e.code,generalLwm:false}));try{const active=await learning.active();model.activeRegistryId=active._id;model.activeModelHash=active.artifactHash;model.learnedHead=active.artifactJson!=='null';}catch(e){model.ready=false;model.error=e.code;}return {ontology,model,policyUpdate:'Qualified native trajectories → deterministic neural head update (260 parameters) → held-out gate → independent release / rollback. H and E unchanged.',benchmark:'Synthetic demo learning validation is not field-effectiveness or industrial certification'};}

  function normalizeDefinition(input){
    const type=requiredText(input.type,'type',80);
    if(!['Matter','Observation'].includes(type))throw issue('ONTOLOGY_SCOPE','Controlled demo edits are additive properties on Matter or Observation');
    if(!Array.isArray(input.fields)||input.fields.length<1||input.fields.length>10)throw issue('INVALID_SCHEMA','1–10 fields required');
    const target=schema.objectTypes.find(t=>t.name===type), names=new Set();
    const fields=input.fields.map(field=>{
      if(!/^[a-z][A-Za-z0-9]{1,39}$/.test(field.name)||names.has(field.name)||target.fields.some(f=>f.name===field.name))throw issue('INVALID_SCHEMA','Duplicate, reserved or existing property: '+field.name);
      if(!['String','Float','Int','Boolean'].includes(field.type))throw issue('INVALID_SCHEMA','Unsupported property type');
      names.add(field.name);return {name:field.name,type:field.type};
    });
    // Parse through the native ODL parser, never eval user expressions.
    parseOdl(`type ${type} @objectType { id: ID! @primary ${fields.map(f=>f.name+': '+f.type).join(' ')} }`);
    return {type,fields};
  }
  async function suggestMapping(input,principal){
    assertReader(principal);await reconcileOntology();
    if(!Array.isArray(input.rows)||!input.rows.length||input.rows.length>50)throw issue('INVALID_INPUT','Supply 1–50 JSON rows');
    const aliases={matterNumber:['matterNumber','编号','案件编号','id'],title:['title','标题','名称'],jurisdiction:['jurisdiction','地区','管辖'],currentState:['currentState','状态'],source:['source','来源'],evidence:['evidence','证据','摘要']};
    const columns=Object.keys(input.rows[0]);
    const mapping=Object.fromEntries(Object.entries(aliases).map(([target,names])=>[target,columns.find(k=>names.includes(k))??'']));
    const fields=columns.filter(c=>!Object.values(mapping).includes(c)&&/^[a-z][A-Za-z0-9]{1,39}$/.test(c)&&!schema.objectTypes.find(t=>t.name==='Matter').fields.some(f=>f.name===c)).map(name=>({name,type:input.rows.every(row=>typeof row[name]==='number')?'Float':'String'}));
    return {mapping,suggestion:{type:'Matter',fields},method:'Deterministic header matching and sample type inference; not an LLM',requiresApproval:true};
  }
  async function analyse(input,principal){
    assertReader(principal);const matters=await all('Matter'),observations=await all('Observation');
    const query=requiredText(input.query??'全部事项','query',200);
    let filter;
    if(/(未核验|unverified)/i.test(query)){const ids=new Set();for(const obs of observations.filter(o=>!o.verified)){for(const l of (await storage.getLinks(ctx,obs._id,'MatterObservation','inbound')).items)ids.add(l._fromId);}filter=m=>ids.has(m._id);}
    else if(/(高风险|high risk)/i.test(query))filter=m=>['HIGH','CRITICAL'].includes(m.riskBand);
    else if(/(待审批|pending|审查)/i.test(query))filter=m=>m.status==='IN_REVIEW';
    else if(/^(全部事项|all)$/i.test(query))filter=()=>true;
    else throw issue('QUERY_OUT_OF_SCOPE','Supported read-only queries: 全部事项 / 未核验 / 高风险 / 待审批');
    const view=createLegacyProjection(schema,await all('OntologyDraft'));
    const rows=matters.filter(filter).map(view.object).filter(Boolean);return {query,tool:'native-object-query',readOnly:true,rows,groups:Object.fromEntries([...new Set(rows.map(m=>m.currentState))].map(state=>[state,rows.filter(m=>m.currentState===state).length])),versions:rows.map(m=>({id:m._id,version:m._version}))};
  }
  async function command(operation,input,principal,key){
    assertReader(principal);
    if(!Object.hasOwn(plusRoles,operation)||!principal.roles.includes(plusRoles[operation]))throw issue('FORBIDDEN','Required role: '+(plusRoles[operation]??'unsupported'),403);
    if(['draftOntology','publishOntology'].includes(operation)&&(await storage.getSchema(ctx)).objectTypes.some(t=>t.name==='PlusOntologyHead')&&(await all('PlusOntologyHead')).length)throw issue('ONTOLOGY_CATALOG_OWNS_PUBLICATION','Use the governed persistent v2 ontology catalog',409);
    if(typeof key!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(key))throw issue('IDEMPOTENCY_REQUIRED','8–128 character request key required');
    if(!input||typeof input!=='object'||Array.isArray(input))throw issue('INVALID_INPUT','Object input required');
    const commandKey=digest([principal.tenantId,principal.id,key]),commandHash=digest([operation,input]);
    const previous=(await all('NativeCommandReceipt')).find(r=>r.commandKey===commandKey);
    if(previous){if(previous.commandHash!==commandHash)throw issue('IDEMPOTENCY_CONFLICT','Request key already used',409);return {success:true,replayed:true,receipt:previous};}
    await reconcileOntology();
    const workspace=(await all('WorkspaceControl'))[0], at=new Date().toISOString();
    const refs={workspace}, effects=[], preconditions=[], params={operation,workspace:workspace._id,expectedWorkspaceVersion:workspace._version};
    let resultType,resultAlias,extra={};
    function result(type,values,alias='result'){effects.push(create(type,values,alias));resultType=type;resultAlias=alias;}
    async function reference(alias,type,id){const obj=await get(type,id);refs[alias]=obj;params[alias]=obj._id;preconditions.push({expr:`${alias} != null && ${alias}._version == ${obj._version}`,error:'Object changed while plan was prepared'});return obj;}
    const nowFields={createdBy:principal.id,createdAt:at};
    const learningContext={reference,result,effects,update,extra,commandKey,at,setResult:(type,alias)=>{resultType=type;resultAlias=alias;}};
    if(await learning.compile(operation,input,principal,learningContext)){
      // All effects still commit through the same native action and receipt.
    }else if(operation==='draftOntology'){
      const definition=normalizeDefinition(input);result('OntologyDraft',{key:commandKey,definitionJson:JSON.stringify(definition),status:'DRAFT',...nowFields});
    }else if(operation==='publishOntology'){
      const draft=await reference('draft','OntologyDraft',input.id);
      if(draft.status!=='DRAFT'||draft.createdBy===principal.id)throw issue('INDEPENDENT_APPROVAL','A different model owner must approve an unpublished draft',409);
      normalizeDefinition(parse(draft.definitionJson));effects.push(update('draft',{status:'APPROVED',approvedBy:principal.id}));resultType='OntologyDraft';resultAlias='draft';
    }else if(operation==='importBatch'||operation==='migrateLegacy'){
      if(!Array.isArray(input.rows)||!input.rows.length||input.rows.length>50)throw issue('IMPORT_LIMIT','1–50 rows required');
      const mapping=input.mapping??{},source=requiredText(input.source,'source',1000),seen=new Set();
      const expected=['matterNumber','title','jurisdiction','currentState','source','evidence'];
      const allowedExtra=schema.objectTypes.find(t=>t.name==='Matter').fields.filter(f=>!f.directives.length&&!['workspaceKey','matterNumber','title','jurisdiction','status','currentState','riskBand','owner','summary','openedAt','dueAt','id'].includes(f.name));
      const rows=input.rows.map((row,index)=>{
        if(!row||typeof row!=='object'||Array.isArray(row))throw issue('INVALID_ROW','Row '+(index+1)+' must be an object');
        const out=Object.fromEntries(expected.map(field=>[field,row[mapping[field]??field]]));
        out.source=out.source||source+'/row-'+(index+1);out.jurisdiction=out.jurisdiction||'DEMO';
        for(const f of expected)requiredText(out[f],f);
        if(!allowedStates.includes(out.currentState)||seen.has(out.matterNumber))throw issue('ROW_QUALITY','Invalid state or duplicate matter number at row '+(index+1));
        seen.add(out.matterNumber);out.extra={};
        for(const field of allowedExtra){const value=row[mapping[field.name]??field.name];if(value==null)continue;const good=field.type.name==='String'?typeof value==='string':field.type.name==='Boolean'?typeof value==='boolean':typeof value==='number'&&Number.isFinite(value)&&(field.type.name!=='Int'||Number.isSafeInteger(value));if(!good)throw issue('FIELD_TYPE','Invalid type for published field '+field.name);out.extra[field.name]=value;}
        if(operation==='migrateLegacy'){
          out.legacyId=requiredText(row.legacyId,'legacyId',100);
          out.observations=Array.isArray(row.observations)?row.observations:[];
          if(out.observations.length>20)throw issue('IMPORT_LIMIT','At most 20 legacy observations per matter');
          for(const observation of out.observations){requiredText(observation.summary,'legacy evidence');requiredText(observation.source,'legacy source');}
        }
        return out;
      });
      for(const [i,row] of rows.entries()){
        effects.push(create('Matter',{workspaceKey:'lwm-demo',matterNumber:row.matterNumber,title:row.title,jurisdiction:row.jurisdiction,currentState:row.currentState,status:'NEW',riskBand:'MEDIUM',owner:principal.id,openedAt:at,...row.extra},'matter'+i));
        for(const [j,evidence] of (row.observations?.length?row.observations:[{summary:row.evidence,source:row.source}]).entries()){
          effects.push(create('Observation',{workspaceKey:'lwm-demo',observationNumber:commandKey+'-'+i+'-'+j,title:row.title,kind:'DOCUMENT',source:evidence.source,summary:evidence.summary,confidence:0,verified:false,recordedBy:principal.id,observedAt:at},'observation'+i+'_'+j));
          effects.push(link('MatterObservation','matter'+i,'observation'+i+'_'+j));
        }
      }
      result('ImportBatch',{key:commandKey,source,mappingJson:JSON.stringify(mapping),reportJson:JSON.stringify({rows:rows.length,quality:'validated',inputHash:digest(input.rows),unverifiedEvidence:true}),...nowFields});
      if(operation==='migrateLegacy')effects.push(create('MigrationRecord',{key:commandKey,sourceHash:digest(input.rows),reportJson:JSON.stringify({source,idMapping:rows.map(r=>({legacyId:r.legacyId,matterNumber:r.matterNumber})),policy:'Preserve matter identity/current state and individual evidence; all evidence requires re-verification. Historical decisions, model scores and eligibility remain archived, not executable.'}),...nowFields},'migration'));
    }else if(operation==='simulate'){
      const matter=await reference('matter','Matter',input.matter), observation=await reference('observation','Observation',input.observation);
      if(matter._version!==input.expectedVersion||!observation.verified)throw issue('CONFLICT','Fresh matter version and verified evidence required',409);
      const links=(await storage.getLinks(ctx,observation._id,'MatterObservation','inbound')).items;
      if(!links.some(l=>l._fromId===matter._id))throw issue('BINDING','Evidence belongs to another matter',409);
      if(!Array.isArray(input.options)||input.options.length<2||input.options.length>4)throw issue('INVALID_PLAN','Compare 2–4 options');
      if(Object.keys(input).some(k=>!['matter','observation','expectedVersion','options','initialAction','behaviorDemonstrations','observationDemonstrations'].includes(k)))throw issue('MODEL_CONTRACT','Unknown simulation field');
      const policy=await learning.active();await reference('policy','DecisionPolicy',policy._id);
      const model=await dynamicsRequest('/v1/simulate',{options:input.options,initialAction:input.initialAction,behaviorDemonstrations:input.behaviorDemonstrations,observationDemonstrations:input.observationDemonstrations,artifactJson:policy.artifactJson});
      const output={...model,facts:{matterId:matter._id,matterVersion:matter._version,observationId:observation._id,observationVersion:observation._version},assumptions:'All binary state, schedules, contexts and costs are user-supplied assumptions; no automatic extraction or legal validity judgment'};
      result('SimulationRun',{key:commandKey,matterId:matter._id,matterVersion:matter._version,inputJson:JSON.stringify(input),outputJson:JSON.stringify(output),modelHash:model.modelHash,policyId:policy._id,...nowFields});extra={prediction:output};
    }else if(operation==='propose'){
      const simulation=await reference('simulation','SimulationRun',input.simulation), output=parse(simulation.outputJson);
      const matter=await reference('matter','Matter',simulation.matterId), observation=await reference('observation','Observation',output.facts.observationId);
      if(simulation.matterVersion!==matter._version||output.facts.observationVersion!==observation._version||!observation.verified)throw issue('STALE_SCENARIO','Rerun simulation after facts or evidence change',409);
      const transitions={EVIDENCE_COMPLETE:['RETENTION_REQUIRED','MANUAL_REVIEW'],NOTICE_RECEIVED:['NOTICE_TIMELY','NOTICE_REQUIRES_CLARIFICATION'],CLAIM_RECEIVED:['RESPONSE_READY','MANUAL_REVIEW']};
      if(!transitions[matter.currentState]?.includes(input.toState))throw issue('INVALID_TRANSITION','Target outside published demo rules');
      const rationale=requiredText(input.rationale,'human decision rationale');
      const optionIndex=input.optionIndex??output.recommendedIndex;
      if(!Number.isSafeInteger(optionIndex)||!output.options[optionIndex])throw issue('INVALID_PLAN','Select an existing simulated option');
      effects.push(update('matter',{status:'IN_REVIEW'}));
      result('TransitionProposal',{workspaceKey:'lwm-demo',proposalNumber:commandKey,title:rationale,fromState:matter.currentState,toState:input.toState,status:'PENDING',riskBand:'MEDIUM',confidence:0,rationale,evidenceSummary:observation.summary,gateStatus:'PASS',gateReason:'Human selects business/legal target; model provides conditional R/H/E probabilities only',proposedBy:principal.id,basisObservationId:observation._id,basisObservationVersion:observation._version,simulationId:simulation._id,plannedOptionIndex:optionIndex,createdAt:at},'proposal');
      effects.push(link('MatterProposal','matter','proposal'));
    }else if(operation==='recordOutcome'){
      const simulation=await reference('simulation','SimulationRun',input.simulation),matter=await reference('matter','Matter',simulation.matterId);
      if(matter.status!=='DECIDED')throw issue('NOT_EXECUTED','An approved business action must execute before recording its outcome',409);
      const approved=(await all('TransitionProposal')).find(p=>p.simulationId===simulation._id&&p.status==='APPROVED');
      if(!approved)throw issue('NO_EXECUTED_PLAN','Outcome must reference the simulation used by an approved proposal',409);
      if(approved.plannedOptionIndex!==input.optionIndex)throw issue('OUTCOME_PLAN_MISMATCH','Outcome must match the option selected in the approved proposal',409);
      const options=parse(simulation.outputJson).options;
      if(!Number.isSafeInteger(input.optionIndex)||!options[input.optionIndex]||![0,1].includes(input.actual))throw issue('INVALID_OUTCOME','Select an existing option and actual ACT/REFRAIN outcome');
      result('OutcomeRecord',{key:simulation._id,matterId:matter._id,simulationId:simulation._id,optionIndex:input.optionIndex,actual:input.actual,evidence:requiredText(input.evidence,'outcome evidence'),recordedBy:principal.id,status:'HELD',privacyConfirmed:false,createdAt:at});
    }else if(operation==='qualifyOutcome'||operation==='withdrawOutcome'){
      const outcome=await reference('outcome','OutcomeRecord',input.id);
      if(operation==='qualifyOutcome'){
        if(outcome.status!=='HELD'||outcome.recordedBy===principal.id||input.privacyConfirmed!==true)throw issue('QUALIFICATION','Independent verifier and explicit privacy confirmation required',409);
        effects.push(update('outcome',{status:'VERIFIED',verifiedBy:principal.id,privacyConfirmed:true,evidence:outcome.evidence+'\nVerification: '+requiredText(input.note,'verification evidence')}));
      }else{
        effects.push(update('outcome',{status:'WITHDRAWN',evidence:outcome.evidence+'\nWithdrawal: '+requiredText(input.note,'withdrawal reason')}));
        await learning.suspend(r=>r.outcomeId===outcome._id,learningContext);
      }
      const proposal=(await all('TransitionProposal')).find(p=>p.simulationId===outcome.simulationId&&p.status==='APPROVED');
      if(proposal){
        const reviewLinks=(await storage.getLinks(ctx,proposal._id,'ProposalReview','outbound')).items;
        if(reviewLinks.length){const feedbackLinks=(await storage.getLinks(ctx,reviewLinks[0]._toId,'ReviewFeedback','outbound')).items;
          if(feedbackLinks.length){await reference('feedback','FeedbackEvent',feedbackLinks[0]._toId);effects.push(update('feedback',{eligibility:'HELD',label:outcome.actual?'ACT':'REFRAIN',reason:'End-state-only feedback remains HELD; separately recorded full TrajectoryFeedback must pass independent qualification and frozen dataset gates. '+outcome.evidence,modelVersion:(await get('SimulationRun',outcome.simulationId)).policyId}));}}
      }
      resultType='OutcomeRecord';resultAlias='outcome';
    }else throw issue('UNKNOWN_COMMAND','Unsupported operation',404);

    const requestContext={tenantId:principal.tenantId,traceId:randomUUID()};
    const manifest={action:'NativePlusCommand',version:1,reversible:false,
      preconditions:[{expr:`actor.hasRole('${plusRoles[operation]}')`,error:'Role denied'},
        {expr:'workspace._version == params.expectedWorkspaceVersion',error:'Concurrent Plus command; refresh and retry'},...preconditions],
      effects:[...effects,update('workspace',{updatedAt:at}),create('NativeCommandReceipt',{commandKey,commandHash,actorId:principal.id,actionName:'NativePlusCommand:'+operation,resultType,resultId:'pending',traceId:requestContext.traceId,createdAt:at},'receipt')],sideEffects:[]};
    manifest.effects.at(-1).properties.resultId=resultAlias+'._id';
    const executed=await actionExecutor.execute(manifest,params,{...principal,type:'user'},{requestContext},schema);
    if(!executed.success){await auditStore.append({id:randomUUID(),tenantId:principal.tenantId,timestamp:at,traceId:requestContext.traceId,actor:{id:principal.id,type:'user',roles:principal.roles},operation:{type:'action',actionType:'NativePlusCommand:'+operation},detail:{result:'failure',errors:executed.errors}});throw issue('ACTION_FAILED',executed.errors.map(e=>e.message).join('; '),409);}
    if(operation==='publishOntology')extra.ontology=await reconcileOntology({apply:true});
    const receipt=(await all('NativeCommandReceipt')).find(r=>r.commandKey===commandKey);
    return {...executed,receipt,...extra};
  }
  return {read,command,suggestMapping,analyse,reconcileOntology};
}

import {createPrivateAuthorizationRevision} from './private-authority.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const name=value=>typeof value==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(value);
const text=value=>typeof value==='string'&&value.length>0&&value.length<=256&&value.trim()===value&&!/[\x00-\x1f\x7f]/.test(value);
const strings=(values,check=text)=>Array.isArray(values)&&values.length>0&&values.length<=128&&values.every(check)&&new Set(values).size===values.length;

// A read-only projection of native objects, not a parallel object database.
// Browse permission is explicit; action/FIT/ontology privileges do not imply it.
export function createPrivateObjectReader({storage,tenantId,identities,loadPolicy,reauthenticate,catalog}){
  const authority=createPrivateAuthorizationRevision({tenantId,identities,loadPolicy,reauthenticate});
  async function prepare(type,principal){
    const actor=structuredClone(principal);
    if(!name(type))fail('OBJECT_READ_INVALID_INPUT');
    const ctx={tenantId,actorId:actor.id},revision=await authority(actor),epoch=await storage.getReadRevision(ctx);
    const policy=loadPolicy().objectBrowser;
    if(!policy||policy.enabled!==true)fail('OBJECT_READ_FORBIDDEN');
    if(policy.version!=='plus-private-object-browser-v1'||Object.keys(policy).some(k=>!['version','enabled','grants','linkGrants'].includes(k))
      ||!Array.isArray(policy.grants)||policy.grants.length>1000)fail('OBJECT_READ_POLICY_INVALID');
    if(policy.linkGrants!==undefined&&(!Array.isArray(policy.linkGrants)||policy.linkGrants.length>1000))fail('OBJECT_READ_POLICY_INVALID');
    for(const grant of policy.grants){
      if(!grant||Object.keys(grant).some(k=>!['principalId','requiredRoles','objectType','scopeField','workspaces','fields'].includes(k))
        ||!text(grant.principalId)||!strings(grant.requiredRoles)||!name(grant.objectType)||!name(grant.scopeField)
        ||!strings(grant.workspaces)||!strings(grant.fields,name))fail('OBJECT_READ_POLICY_INVALID');
    }
    const grants=policy.grants.filter(g=>g.principalId===actor.id&&g.objectType===type&&g.requiredRoles.every(r=>actor.roles.includes(r)));
    if(!grants.length)fail('OBJECT_READ_FORBIDDEN');
    const current=await catalog.read(actor),definition=current.bundle.parsed.objectTypes.find(t=>t.name===type);
    if(!definition)fail('OBJECT_READ_POLICY_INVALID');
    const readable=field=>definition.fields.some(f=>f.name===field&&!f.directives.some(d=>['link','computed'].includes(d.kind)));
    if(grants.some(g=>!readable(g.scopeField)||g.fields.some(f=>!readable(f))))fail('OBJECT_READ_POLICY_INVALID');
    return {actor,ctx,revision,epoch,grants,definition,schema:current.bundle.parsed,linkGrants:structuredClone(policy.linkGrants??[])};
  }
  async function fence(state){
    if(await authority(state.actor)!==state.revision)fail('OBJECT_READ_AUTHORITY_STALE');
    if(await storage.getReadRevision(state.ctx)!==state.epoch)fail('OBJECT_READ_STALE');
  }
  function project(object,type,id,grants){
    // Missing and out-of-scope identifiers share a response; existence is not a grant.
    if(!object||object._deletedAt||object._tenantId!==tenantId||object._type!==type||object._id!==id)fail('OBJECT_READ_NOT_FOUND');
    const eligible=grants.filter(g=>typeof object[g.scopeField]==='string'&&g.workspaces.includes(object[g.scopeField]));
    if(!eligible.length)fail('OBJECT_READ_NOT_FOUND');
    // Do not union grants across scopes or silently pick a broader one by order.
    if(eligible.length!==1)fail('OBJECT_READ_POLICY_INVALID');
    const projected={_tenantId:object._tenantId,_type:object._type,_id:object._id,_version:object._version};
    for(const field of eligible[0].fields)if(Object.hasOwn(object,field))projected[field]=structuredClone(object[field]);
    return {object:projected,reference:{type,id,version:object._version},readOnly:true};
  }
  async function linked(type,id,input,principal,all=false){
    const query=structuredClone(input);
    if(!text(id)||!query||typeof query!=='object'||Array.isArray(query)||Object.keys(query).some(k=>!['linkType','direction','limit','after'].includes(k))
      ||!name(query.linkType)||!['inbound','outbound'].includes(query.direction)||Object.values(query).some(v=>typeof v!=='string')
      ||query.limit!==undefined&&!/^(?:[1-9]|[1-4][0-9]|50)$/.test(query.limit)||query.after!==undefined&&!text(query.after))fail('OBJECT_READ_INVALID_INPUT');
    const state=await prepare(type,principal),root=await storage.getObject(state.ctx,type,id),rootView=project(root,type,id,state.grants);
    const definition=state.schema.linkTypes.find(link=>link.name===query.linkType),outbound=query.direction==='outbound';
    if(!definition||(outbound?definition.from:definition.to)!==type)fail('OBJECT_LINK_INVALID_DIRECTION');
    const validScope=scope=>scope&&typeof scope==='object'&&!Array.isArray(scope)&&Object.keys(scope).length===2&&Object.keys(scope).every(k=>['scopeField','workspaces'].includes(k))&&name(scope.scopeField)&&strings(scope.workspaces);
    for(const grant of state.linkGrants){
      if(!grant||Object.keys(grant).some(k=>!['principalId','requiredRoles','linkType','directions','from','to','fields'].includes(k))
        ||!text(grant.principalId)||!strings(grant.requiredRoles)||!name(grant.linkType)||!strings(grant.directions,v=>['inbound','outbound'].includes(v))
        ||!validScope(grant.from)||!validScope(grant.to)||!Array.isArray(grant.fields)||grant.fields.length>128||grant.fields.some(f=>!name(f))||new Set(grant.fields).size!==grant.fields.length)fail('OBJECT_READ_POLICY_INVALID');
    }
    const matching=state.linkGrants.filter(g=>g.principalId===state.actor.id&&g.requiredRoles.every(r=>state.actor.roles.includes(r))&&g.linkType===query.linkType&&g.directions.includes(query.direction));
    if(!matching.length)fail('OBJECT_LINK_FORBIDDEN');
    const targetType=outbound?definition.to:definition.from,other=await prepare(targetType,state.actor);
    if(other.epoch!==state.epoch||other.revision!==state.revision)fail('OBJECT_READ_STALE');
    const scoped=(object,scope)=>typeof object[scope.scopeField]==='string'&&scope.workspaces.includes(object[scope.scopeField]);
    for(const grant of matching){
      const rootScope=outbound?grant.from:grant.to,otherScope=outbound?grant.to:grant.from;
      if(!state.definition.fields.some(f=>f.name===rootScope.scopeField&&f.type.name==='String'&&!f.type.isList&&!f.directives.some(d=>['link','computed'].includes(d.kind)))
        ||!other.definition.fields.some(f=>f.name===otherScope.scopeField&&f.type.name==='String'&&!f.type.isList&&!f.directives.some(d=>['link','computed'].includes(d.kind)))
        ||grant.fields.some(field=>!definition.fields.some(f=>f.name===field&&!f.directives.some(d=>['link','computed'].includes(d.kind)))))fail('OBJECT_READ_POLICY_INVALID');
    }
    const grants=matching.filter(g=>scoped(root,outbound?g.from:g.to));if(!grants.length)fail('OBJECT_LINK_FORBIDDEN');
    // Native memory SPI does not order getLinks. Bound the one-hop collection,
    // then project/filter/sort BEFORE public pagination. Never use raw counts.
    const page=await storage.getLinks(state.ctx,id,query.linkType,query.direction,{limit:1001});
    if(page.hasNextPage||page.items.length>1000||page.totalCount!==page.items.length)fail('OBJECT_LINK_SCAN_LIMIT');
    if(new Set(page.items.map(l=>l._id)).size!==page.items.length)fail('OBJECT_LINK_INTEGRITY_ERROR');
    const limit=all?1000:Number(query.limit??25),items=[];
    for(const link of [...page.items].sort((a,b)=>a._id<b._id?-1:a._id>b._id?1:0)){
      if(link._deletedAt||query.after!==undefined&&link._id<=query.after)continue;
      if(link._tenantId!==tenantId||link._type!==query.linkType||link._fromType!==definition.from||link._toType!==definition.to||(outbound?link._fromId:link._toId)!==id)fail('OBJECT_LINK_INTEGRITY_ERROR');
      const targetId=outbound?link._toId:link._fromId,object=await storage.getObject(state.ctx,targetType,targetId);
      let neighbor;try{neighbor=project(object,targetType,targetId,other.grants);}catch(error){if(error.code==='OBJECT_READ_NOT_FOUND')continue;throw error;}
      const allowed=grants.filter(g=>scoped(object,outbound?g.to:g.from));if(!allowed.length)continue;if(allowed.length!==1)fail('OBJECT_READ_POLICY_INVALID');
      const projected={_tenantId:link._tenantId,_type:link._type,_id:link._id,_version:link._version,_fromType:link._fromType,_fromId:link._fromId,_toType:link._toType,_toId:link._toId};
      for(const field of allowed[0].fields)if(Object.hasOwn(link,field))projected[field]=structuredClone(link[field]);
      items.push({link:projected,neighbor});if(items.length>limit)break;
    }
    await fence(state);await fence(other);
    const hasMore=items.length>limit,visible=items.slice(0,limit);
    return {root:rootView.reference,linkType:query.linkType,direction:query.direction,items:visible,hasMore,nextAfter:hasMore?visible.at(-1).link._id:null,readOnly:true};
  }
  async function analysis(type,id,input,principal){
    const query=structuredClone(input);
    if(!query||typeof query!=='object'||Array.isArray(query)||Object.keys(query).sort().join(',')!=='direction,field,linkType,mode'
      ||!name(query.field)||!name(query.linkType)||!['inbound','outbound'].includes(query.direction)||!['GROUP_COUNT','NUMERIC_SUMMARY'].includes(query.mode))fail('OBJECT_READ_INVALID_INPUT');
    const state=await prepare(type,principal),definition=state.schema.linkTypes.find(l=>l.name===query.linkType),outbound=query.direction==='outbound';
    if(!definition||(outbound?definition.from:definition.to)!==type)fail('OBJECT_LINK_INVALID_DIRECTION');
    const targetType=outbound?definition.to:definition.from,other=await prepare(targetType,state.actor),field=other.definition.fields.find(f=>f.name===query.field);
    if(other.epoch!==state.epoch||other.revision!==state.revision)fail('OBJECT_READ_STALE');
    // Aggregate membership must not reveal a field hidden by any participating
    // scope. Existing object, endpoint AND edge grants still apply separately.
    if(other.grants.some(g=>!g.fields.includes(query.field)))fail('OBJECT_READ_FORBIDDEN');
    const numeric=['Int','Float'].includes(field?.type?.name),categorical=['String','Boolean'].includes(field?.type?.name)||other.schema.enums.some(e=>e.name===field?.type?.name);
    if(!field||field.type.isList||field.directives.some(d=>['computed','link'].includes(d.kind))||!(query.mode==='NUMERIC_SUMMARY'?numeric:categorical))fail('OBJECT_READ_UNSUPPORTED_FILTER');
    const graph=await linked(type,id,{linkType:query.linkType,direction:query.direction},state.actor,true),unique=new Map(),links=[];
    if(graph.hasMore)fail('OBJECT_LINK_SCAN_LIMIT');
    for(const item of graph.items){const r=item.neighbor.reference,k=r.type+':'+r.id,previous=unique.get(k);
      if(previous&&previous.reference.version!==r.version)fail('OBJECT_READ_STALE');unique.set(k,item.neighbor);
      links.push({type:item.link._type,id:item.link._id,version:item.link._version,from:{type:item.link._fromType,id:item.link._fromId},to:{type:item.link._toType,id:item.link._toId}});
    }
    const rows=[...unique.values()].sort((a,b)=>a.reference.id.localeCompare(b.reference.id)),groups=new Map();let missing=0,nulls=0,sum=0,min=null,max=null,count=0;
    for(const row of rows){const present=Object.hasOwn(row.object,query.field),value=row.object[query.field];
      const cell=!present?{kind:'UNOBSERVED'}:value===null?{kind:'MISSING'}:{kind:'VALUE',value};
      if(!present)missing++;else if(value===null)nulls++;
      if(query.mode==='GROUP_COUNT'){
        if(present&&value!==null&&(typeof value!==(['Boolean'].includes(field.type.name)?'boolean':'string')||typeof value==='string'&&value.length>512))fail('OBJECT_READ_INVALID_INPUT');
        const k=JSON.stringify(cell);if(!groups.has(k)){if(groups.size>=32)fail('OBJECT_LINK_SCAN_LIMIT');groups.set(k,{value:cell,count:0,members:[]});}
        const group=groups.get(k);group.count++;group.members.push(structuredClone(row.reference));
      }else if(present&&value!==null){
        if(typeof value!=='number'||!Number.isFinite(value)||field.type.name==='Int'&&!Number.isSafeInteger(value))fail('OBJECT_READ_INVALID_INPUT');sum+=value;if(!Number.isFinite(sum))fail('OBJECT_READ_INVALID_INPUT');
        min=min===null?value:Math.min(min,value);max=max===null?value:Math.max(max,value);count++;
      }
    }
    await fence(state);await fence(other);
    return {schema:'plus-object-analysis-v1',root:graph.root,targetType,linkType:query.linkType,direction:query.direction,field:query.field,mode:query.mode,
      scope:'AUTHORIZED_ONE_HOP',countUnit:'DISTINCT_OBJECT',objectCount:rows.length,visibleLinkCount:links.length,missingCount:missing,nullCount:nulls,
      groups:query.mode==='GROUP_COUNT'?[...groups.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,g])=>g):null,
      numeric:query.mode==='NUMERIC_SUMMARY'?{count,sum:count?sum:null,mean:count?sum/count:null,min,max}:null,
      sources:{objects:rows.map(r=>structuredClone(r.reference)),links},readOnly:true,snapshotConsistent:true,predictionReady:false,executionAuthorized:false};
  }
  return {links:(type,id,input,principal)=>linked(type,id,input,principal),analysis,async read(type,id,principal){
    if(!text(id))fail('OBJECT_READ_INVALID_INPUT');
    const state=await prepare(type,principal),object=await storage.getObject(state.ctx,type,id);
    const result=project(object,type,id,state.grants);
    await fence(state);return result;
  },async list(type,input,principal){
    const query=structuredClone(input);
    if(!query||typeof query!=='object'||Array.isArray(query)||Object.keys(query).some(k=>!['limit','after','field','operator','value'].includes(k))
      ||Object.values(query).some(v=>typeof v!=='string'))fail('OBJECT_READ_INVALID_INPUT');
    if(query.limit!==undefined&&!/^(?:[1-9]|[1-4][0-9]|50)$/.test(query.limit))fail('OBJECT_READ_INVALID_INPUT');
    if(query.after!==undefined&&!text(query.after))fail('OBJECT_READ_INVALID_INPUT');
    const filtered=['field','operator','value'].some(k=>Object.hasOwn(query,k));
    if(filtered&&(!name(query.field)||!['eq','contains','startsWith'].includes(query.operator)||!text(query.value)))fail('OBJECT_READ_INVALID_INPUT');
    const state=await prepare(type,principal),{grants,definition}=state,limit=Number(query.limit??25);
    // A page must have a provably disjoint scope partition before filtering or
    // pagination. Otherwise even hasMore could reveal a hidden field or scope.
    for(let i=0;i<grants.length;i++)for(let j=i+1;j<grants.length;j++){
      if(grants[i].scopeField!==grants[j].scopeField||grants[i].workspaces.some(w=>grants[j].workspaces.includes(w)))fail('OBJECT_READ_POLICY_INVALID');
    }
    const predicates=[{or:grants.map(g=>({field:g.scopeField,operator:'in',value:g.workspaces}))}];
    if(query.after!==undefined)predicates.push({field:'_id',operator:'gt',value:query.after});
    if(filtered){
      // Predicate permission is also read permission. Do not let membership
      // in a result page act as an oracle for unprojected attributes.
      if(grants.some(g=>!g.fields.includes(query.field)))fail('OBJECT_READ_FORBIDDEN');
      const field=definition.fields.find(f=>f.name===query.field);
      if(!field||field.type.isList||field.type.name!=='String')fail('OBJECT_READ_UNSUPPORTED_FILTER');
      predicates.push({field:query.field,operator:query.operator,value:query.value});
    }
    const page=await storage.queryObjects(state.ctx,type,{and:predicates},{limit:limit+1,orderBy:[{field:'_id',direction:'asc'}]});
    const projected=page.items.map(o=>project(o,type,o._id,grants));
    await fence(state);
    const hasMore=projected.length>limit,items=projected.slice(0,limit);
    // Public keyset, not a credential or snapshot. Every page rechecks current
    // native data/authority. Never expose global counts or authority digests.
    return {items,hasMore,nextAfter:hasMore?items.at(-1).reference.id:null,readOnly:true};
  }};
}

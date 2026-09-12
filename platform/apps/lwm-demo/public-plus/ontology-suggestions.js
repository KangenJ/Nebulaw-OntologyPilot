// Conservative local structural assistance, not an LLM or causal inference.
// Sample values never enter suggestions; only optional primitive properties can
// be proposed to the existing native preview/independent-publish workflow.
const allowed=name=>typeof name==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(name)&&!['constructor','prototype','__proto__'].includes(name);
const fail=message=>{throw Error(message);};
export function suggestOptionalProperties({rows,objectType,catalog}){
  const types=catalog?.bundle?.parsed?.objectTypes;
  const target=types?.find(t=>t.name===objectType&&!t.name.startsWith('Plus'));
  if(!target||!Array.isArray(target.fields)||typeof catalog?.bundle?.contentHash!=='string')fail('SUGGESTION_CURRENT_ONTOLOGY_REQUIRED');
  if(!Array.isArray(rows)||rows.length<1||rows.length>50||rows.some(r=>!r||Object.getPrototypeOf(r)!==Object.prototype))fail('SUGGESTION_OBJECT_ARRAY_REQUIRED');
  const fields=[...new Set(rows.flatMap(r=>Object.keys(r)))].sort();
  if(fields.length>100)fail('SUGGESTION_FIELD_BUDGET');
  const existing=new Set(target.fields.map(f=>f.name)),suggestions=[],unresolved=[],known=[];
  for(const field of fields){
    if(!allowed(field)){unresolved.push({field,reason:'INVALID_OR_RESERVED_FIELD'});continue;}
    if(existing.has(field)){known.push(field);continue;}
    const values=rows.filter(r=>Object.hasOwn(r,field)).map(r=>r[field]),present=values.filter(v=>v!==null),kinds=new Set(present.map(v=>typeof v));
    const evidence={rows:rows.length,present:values.length,missing:rows.length-values.length,nulls:values.length-present.length};
    if(!present.length){unresolved.push({field,reason:'NO_OBSERVED_TYPE',evidence});continue;}
    if(kinds.size!==1){unresolved.push({field,reason:'MIXED_TYPES_REQUIRE_REVIEW',evidence});continue;}
    const kind=[...kinds][0];let valueType;
    if(kind==='string')valueType='String';
    if(kind==='boolean')valueType='Boolean';
    if(kind==='number'&&present.every(Number.isSafeInteger))valueType='Int';
    if(!valueType){unresolved.push({field,reason:kind==='object'?'OBJECT_OR_RELATION_REQUIRES_EXPLICIT_MODEL':'UNSUPPORTED_PRIMITIVE_TYPE',evidence});continue;}
    // An ID-shaped column may refer to another object. Do not silently flatten
    // it into a scalar or invent a relation, endpoint, cardinality or authority.
    if(/(?:Id|ID|_id)$/.test(field)){unresolved.push({field,reason:'POSSIBLE_REFERENCE_REQUIRES_EXPLICIT_RELATION',evidence});continue;}
    suggestions.push({field,valueType,nullable:true,evidence,reason:'OBSERVED_PRIMITIVE_OPTIONAL_PROPERTY'});
  }
  return {schema:'plus-optional-property-suggestions-v1',method:'DETERMINISTIC_SAMPLE_TYPE_INFERENCE',objectType,ontologyHash:catalog.bundle.contentHash,sampleCount:rows.length,suggestions,unresolved,known,
    rawValuesIncluded:false,automaticallyPublished:false,modelTrained:false};
}

// Collection names propose business types. Reference-shaped names only nominate
// endpoints: identity, matching values, direction and cardinality need review.
export function suggestBusinessStructure({tables,catalog}){
  if(!tables||Object.getPrototypeOf(tables)!==Object.prototype||Object.keys(tables).length<1||Object.keys(tables).length>4)fail('SUGGESTION_TABLE_BUDGET');
  const types=catalog?.bundle?.parsed?.objectTypes;
  if(!Array.isArray(types)||typeof catalog?.bundle?.contentHash!=='string')fail('SUGGESTION_CURRENT_ONTOLOGY_REQUIRED');
  const existing=types.filter(t=>!t.name.startsWith('Plus')).map(t=>t.name),names=Object.keys(tables).sort();
  if(names.some(name=>!allowed(name)||name.startsWith('Plus')))fail('SUGGESTION_BUSINESS_TYPE_REQUIRED');
  const targets=[...new Set([...existing,...names])],objects=[],links=[],unresolved=[];
  for(const name of names){
    const tableCatalog={bundle:{...catalog.bundle,parsed:{objectTypes:[...types.filter(t=>t.name!==name),{name,fields:types.find(t=>t.name===name)?.fields??[{name:'id'}]}]}}};
    const result=suggestOptionalProperties({rows:tables[name],objectType:name,catalog:tableCatalog});
    if(!existing.includes(name)&&result.suggestions.length)objects.push({name,properties:result.suggestions.slice(0,20).map(s=>({name:s.field,valueType:s.valueType,evidence:s.evidence})),sampleCount:result.sampleCount});
    if(result.suggestions.length>20)unresolved.push({table:name,reason:'PROPERTY_BUDGET_REQUIRES_SPLIT'});
    for(const item of result.unresolved){
      const stem=item.reason==='POSSIBLE_REFERENCE_REQUIRES_EXPLICIT_RELATION'?item.field.replace(/(?:Id|ID|_id)$/,'').toLowerCase():null;
      const matches=stem?targets.filter(target=>target.toLowerCase()===stem):[];
      if(matches.length===1)links.push({name:name+matches[0],from:name,to:matches[0],sourceField:item.field,cardinality:null,
        endpointsPublished:existing.includes(name)&&existing.includes(matches[0]),reason:'NAME_ONLY_REFERENCE_HYPOTHESIS',evidence:item.evidence});
      else unresolved.push({table:name,...item});
    }
  }
  return {schema:'plus-business-structure-suggestions-v1',ontologyHash:catalog.bundle.contentHash,method:'DETERMINISTIC_COLLECTION_AND_FIELD_NAMES',objects,links,unresolved,
    rawValuesIncluded:false,identityMatchesVerified:false,automaticallyPublished:false,permissionsGranted:false};
}

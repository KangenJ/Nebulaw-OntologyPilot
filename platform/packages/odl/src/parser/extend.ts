import { parse, print, Kind, type DefinitionNode, type ObjectTypeDefinitionNode } from 'graphql';

/** Explicit additive authoring helper. Returns complete ODL; runtime parsers never silently apply extensions. */
export function extendOdl(source:string,extension:string):string{
  const base=parse(source),extra=parse(extension),definitions:DefinitionNode[]=[...base.definitions];
  const fail=(message:string):never=>{throw new Error('ODL_EXTENSION: '+message);};
  for(const addition of extra.definitions){
    if(addition.kind===Kind.OBJECT_TYPE_EXTENSION){
      if(addition.directives?.length||addition.interfaces?.length||!addition.fields?.length)fail('only explicit field additions are supported');
      const matches=definitions.map((d,index)=>({d,index})).filter(({d})=>'name'in d&&d.name?.value===addition.name.value);
      if(matches.length!==1||matches[0]!.d.kind!==Kind.OBJECT_TYPE_DEFINITION)fail('unique existing object type required');
      const {d,index}=matches[0]!;const object=d as ObjectTypeDefinitionNode;
      if(!object.directives?.some(d=>d.name.value==='objectType'))fail('only native object types can be extended');
      const fields=[...(object.fields??[])];
      for(const field of addition.fields!){if(fields.some(f=>f.name.value===field.name.value))fail('field already exists: '+addition.name.value+'.'+field.name.value);fields.push(field);}
      definitions[index]={...object,fields};
    }else if([Kind.OBJECT_TYPE_DEFINITION,Kind.ENUM_TYPE_DEFINITION].includes(addition.kind as never)){
      if(!('name'in addition)||!addition.name)fail('named definition required');
      const name=('name'in addition?addition.name?.value:undefined)!;
      if(definitions.some(d=>'name'in d&&d.name?.value===name))fail('type already exists: '+name);
      definitions.push(addition);
    }else fail('unsupported extension definition: '+addition.kind);
  }
  return print({...base,definitions});
}

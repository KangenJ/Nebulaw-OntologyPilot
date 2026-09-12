import {parseOdl} from '@openfoundry/odl';

export function fixture({root='Task',signal='Signal',enumName='Completion',states=['DONE','NOT_DONE']}={}) {
  const parsed=parseOdl(`extend schema @namespace(name: "test.plus", version: "1.0.0")
    enum ${enumName} { ${[...states,'UNKNOWN'].join(' ')} }
    type ${root} @objectType {
      id: ID! @primary
      actual: ${enumName}!
      status: String!
      priority: Int!
      createdAt: DateTime!
      receivedAt: DateTime!
      signals: [${signal}!]! @link(type:"RootSignal",direction:OUTBOUND)
    }
    type ${signal} @objectType {
      id: ID! @primary
      report: ${enumName}! @sensitive
      observedAt: DateTime!
      receivedAt: DateTime!
    }
    type RootSignal @linkType(from:"${root}",to:"${signal}",cardinality:ONE_TO_MANY) { id: ID! @primary }
    type VerifyObject @actionType(permission:"can_review") {
      task: ${root}! @param
      expectedVersion: Int! @param
      note: String! @param
    }`);
  const spiSchema={version:1,objectTypes:parsed.objectTypes.map(t=>({name:t.name,properties:t.fields.filter(f=>!f.directives.some(d=>['primary','link','computed'].includes(d.kind))).map(f=>({name:f.name,type:f.type.name,required:f.type.nonNull}))})),linkTypes:parsed.linkTypes.map(l=>({name:l.name,fromType:l.from,toType:l.to,cardinality:l.cardinality,properties:[]}))};
  const manifest={action:'VerifyObject',version:1,reversible:false,preconditions:[{expr:"actor.hasRole('case_reviewer')",error:'Review required'}],effects:[],sideEffects:[]};
  const semantics={};for(const t of parsed.objectTypes)for(const f of t.fields)semantics[t.name+'.'+f.name]={unit:f.type.name==='DateTime'?'timestamp_utc':'1',roles:['CONTEXT']};
  semantics[root+'.actual']={unit:'1',roles:['LATENT','FACT'],knowledgeOnlyValues:['UNKNOWN']};
  semantics[signal+'.report']={unit:'1',roles:['OBSERVATION']};
  const policy={id:'demo-purpose',readableFields:Object.keys(semantics),actionNames:['VerifyObject'],implementationIds:['categorical-transition-v1','categorical-observation-v1'],scopePolicies:['demo-scope'],verificationPolicies:['independent-check'],fieldSemantics:semantics};
  const common={nullable:false,unit:'1',support:[],unknownValues:[],missingPolicy:{absent:'UNOBSERVED',null:'MISSING',withdrawn:'REVOKED'},verification:{policyRef:'independent-check',mode:'NONE'},accessPolicyRef:policy.id,transform:{kind:'IDENTITY'}};
  const definition={schema:'plus-mechanism-v1',key:'sample.mechanism',revision:1,title:'Typed process example',rootType:root,scope:{key:'synthetic',policyRef:'demo-scope'},variables:[
    {...structuredClone(common),key:'state',role:'LATENT',source:{objectType:root,field:'actual'},valueType:enumName,support:states,unknownValues:['UNKNOWN'],time:{eventTimeField:'createdAt',receivedTimeField:'receivedAt'},verification:{policyRef:'independent-check',mode:'GOLD'}},
    {...structuredClone(common),key:'priority',role:'CONTEXT',source:{objectType:root,field:'priority'},valueType:'Int',time:{eventTimeField:'createdAt',receivedTimeField:'receivedAt'}},
    {...structuredClone(common),key:'report',role:'OBSERVATION',source:{objectType:signal,field:'report',path:{linkType:'RootSignal',direction:'OUTBOUND',aggregation:'LATEST'}},valueType:enumName,support:[...states,'UNKNOWN'],time:{eventTimeField:'observedAt',receivedTimeField:'receivedAt'}}
  ],modules:[{key:'transition',kind:'TRANSITION',inputs:['state','priority'],outputs:['state'],dependsOn:[],implementation:'categorical-transition-v1'},
    {key:'observation',kind:'OBSERVATION',inputs:['state'],outputs:['report'],dependsOn:['transition'],implementation:'categorical-observation-v1'}],
  actions:[{key:'verify',nativeAction:'VerifyObject',effect:'INFORMATION_ONLY',parameters:{task:'ROOT',expectedVersion:'SERVER',note:'INPUT'}}],
  budget:{mechanisms:8,horizon:4,alternatives:2,branchDepth:1},
  utility:{target:'state',decisions:states,losses:states.map((_,i)=>states.map((_,j)=>i===j?0:1)),verificationCost:1,minimumDifference:0.1,unit:'synthetic_utility'}};
  return {definition,context:{parsed,spiSchema,manifestRegistry:{get:name=>name===manifest.action?manifest:undefined},schemaRevision:'test-plus-v1',policy},manifest};
}

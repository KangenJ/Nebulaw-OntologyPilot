/** Private G1 workspace grants. No request may supply this policy or its role/field allowlists. */
export function createTaskDomainAccess({storage,tenantId,loadPolicy,reauthenticate}){
  const own=(o,k)=>o&&Object.hasOwn(o,k)?o[k]:undefined;
  async function configuration(p){await reauthenticate();if(p.tenantId!==tenantId)return undefined;const domain=loadPolicy().taskDomain;return domain?.enabled===true?domain:undefined;}
  return {
    async authorize(p,{action,resources}){
      const domain=await configuration(p);if(!Array.isArray(domain?.grants))return false;
      // One complete grant must cover the operation. Combining partial grants must not widen workspace scope.
      for(const grant of domain.grants.filter(g=>g.principalId===p.id&&Array.isArray(g.actions)&&g.actions.includes(action))){
        if(!Array.isArray(grant.workspaces)||!grant.types)continue;
        let permitted=true;
        for(const resource of resources){
          if(resource.workspaceKey!==undefined&&!grant.workspaces.includes(resource.workspaceKey)){permitted=false;break;}
          const type=own(grant.types,resource.type);
          if(!type||!Array.isArray(type.read)||!Array.isArray(type.write)||resource.operation==='create'&&type.create!==true||resource.readFields.some(f=>!type.read.includes(f))||resource.writeFields.some(f=>!type.write.includes(f))){permitted=false;break;}
          if(resource.id){const o=await storage.getObject({tenantId},resource.type,resource.id);if(!o||o._deletedAt||!grant.workspaces.includes(o.workspaceKey)){permitted=false;break;}}
        }
        if(permitted)return true;
      }
      return false;
    },
    async taskClassificationFor(p,matter){return own((await configuration(p))?.workspaceClassifications,matter.workspaceKey);},
    async sourcePolicyFor(p,key){return own((await configuration(p))?.sources,key);},
    async verificationPolicyFor(p,key){return own((await configuration(p))?.verificationMethods,key);},
    async matterImportPolicyFor(p,key){return own((await configuration(p))?.matterImportSources,key);},
    async ruleImportPolicyFor(p,key){return own((await configuration(p))?.ruleImportSources,key);},
  };
}

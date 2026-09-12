const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pretty=value=>'<pre>'+escape(JSON.stringify(value,null,2))+'</pre>';

export function createNativeLinksView({document,api,run,isBusy,getCatalog,getDetail,onRender,onOpenObject}){
  const $=selector=>document.querySelector(selector);let rootKey='',choice='',page,cursors=[''],pageIndex=0,error='',generation=0;
  function reset(){rootKey='';choice='';page=undefined;cursors=[''];pageIndex=0;error='';generation++;}
  function options(){const type=getDetail()?.reference.type;return (getCatalog()?.bundle?.parsed?.linkTypes??[]).flatMap(link=>[
    ...(link.from===type?[{key:link.name+':outbound',linkType:link.name,direction:'outbound',targetType:link.to}]:[]),
    ...(link.to===type?[{key:link.name+':inbound',linkType:link.name,direction:'inbound',targetType:link.from}]:[]),
  ]);}
  function markup(){
    const ref=getDetail()?.reference,key=ref?JSON.stringify(ref):'';
    if(rootKey!==key){reset();rootKey=key;}
    if(!ref)return '';
    const links=options();if(!links.some(link=>link.key===choice))choice=links[0]?.key??'';
    return `<section class="panel"><h2>原生关联对象与证据</h2><p>查询一跳实际关系。需要关系本身及两端对象的独立授权；类型出现在本体中不表示有权读取关系。当前不是全图搜索或历史快照。</p><form id="links-query"><label>关系与方向<select id="links-choice">${links.map(link=>`<option value="${escape(link.key)}" ${link.key===choice?'selected':''}>${escape(link.linkType)} · ${link.direction==='outbound'?'指向':'来自'} ${escape(link.targetType)}</option>`).join('')||'<option>此对象类型未定义关系</option>'}</select></label><button ${links.length?'':'disabled'}>读取当前关系</button></form>${error?'<p class="error">'+escape(error)+'</p>':''}<p>最多显示25项；仅对可见关系分页，不显示隐藏对象或关系总数。一跳集合超过服务端预算会明确拒绝，不当作完整结果。</p>${page?`<p>原生根对象 ${escape(page.root.type)} / ${escape(page.root.id)} / v${escape(page.root.version)} · 第 ${pageIndex+1} 页</p><div class="table-wrap"><table><thead><tr><th>关系引用</th><th>关联对象</th><th>可读字段</th></tr></thead><tbody>${page.items.map((item,index)=>`<tr><td>${escape(item.link._type)} / ${escape(item.link._id)} / v${escape(item.link._version)}<p>${escape(item.link._fromType)} → ${escape(item.link._toType)}</p><details><summary>授权关系属性</summary>${pretty(item.link)}</details></td><td><button data-linked-object="${index}">${escape(item.neighbor.reference.type)} / ${escape(item.neighbor.reference.id)}</button></td><td>${pretty(item.neighbor.object)}</td></tr>`).join('')||'<tr><td colspan="3">当前授权范围没有可见关系；不代表全平台不存在关联。</td></tr>'}</tbody></table></div>`:'<p>尚未查询或上次查询失败；未显示旧关系结果。</p>'}<div class="row"><button id="links-prev" ${pageIndex===0?'disabled':''}>上一页关系</button><button id="links-next" ${page?.hasMore?'':'disabled'}>下一页关系</button></div></section>`;
  }
  async function load(epoch){
    const option=options().find(link=>link.key===choice),ref=getDetail()?.reference;if(!option||!ref)return;
    const local=generation;page=undefined;error='';onRender();
    const query=new URLSearchParams({linkType:option.linkType,direction:option.direction,limit:'25'});if(cursors[pageIndex])query.set('after',cursors[pageIndex]);
    try{
      const result=await api('/objects/'+encodeURIComponent(ref.type)+'/'+encodeURIComponent(ref.id)+'/links?'+query,epoch);
      if(local!==generation)throw Object.assign(Error('关联会话已变化'),{discarded:true});
      if(result?.readOnly!==true||result.root?.id!==ref.id||result.root?.type!==ref.type||result.linkType!==option.linkType||result.direction!==option.direction||!Array.isArray(result.items))throw Error('INVALID_NATIVE_LINK_PAGE');
      if(result.root.version!==ref.version)throw Error('根对象版本已变化，请重新读取对象详情后查询关系');
      page=result;
    }catch(e){if(!e.discarded&&local===generation)error=String(e.message);throw e;}
    finally{if(local===generation)onRender();}
  }
  function bind(){
    if(!getDetail())return;
    $('#links-choice').onchange=()=>{if(isBusy())return;choice=$('#links-choice').value;page=undefined;error='';cursors=[''];pageIndex=0;onRender();};
    $('#links-query').onsubmit=event=>{event.preventDefault();if(isBusy())return;choice=$('#links-choice').value;cursors=[''];pageIndex=0;void run(load);};
    $('#links-prev').onclick=()=>{if(isBusy()||pageIndex===0)return;pageIndex--;void run(load);};
    $('#links-next').onclick=()=>{if(isBusy()||!page?.hasMore)return;cursors=cursors.slice(0,pageIndex+1);cursors.push(page.nextAfter);pageIndex++;void run(load);};
    document.querySelectorAll('[data-linked-object]').forEach(button=>button.onclick=()=>void run(epoch=>onOpenObject(page.items[Number(button.dataset.linkedObject)].neighbor.reference,epoch)));
  }
  return {markup,bind,reset};
}

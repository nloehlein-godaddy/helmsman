import type { CampaignCommandInputV1, CampaignCommandReceiptV1, CampaignDetailSnapshotV1, CampaignListSnapshotV1, CampaignPendingV1, CampaignPhaseActionV1, CampaignTargetV1, PluginPanelContext, PluginPanelInstance, PluginPanelModule, PluginPanelState } from '@helmsman/plugin-sdk';
import { CampaignStorage, campaignValid, detailValid, emptyDraft, esc, inputValid, listValid, message, receiptValid, type Draft, type ImportDraft, type PhaseDraft } from './state.js';
import { renderCampaigns } from './render.js';
import { styles } from './styles.js';

class CampaignPanel implements PluginPanelInstance {
  private state:PluginPanelState;
  private readonly context:PluginPanelContext;
  private readonly container:HTMLElement;
  private readonly storage:CampaignStorage;
  private draft:Draft=emptyDraft();
  private unsupported=false;
  private storageError='';
  private resultsError='';
  private error='';
  private readError='';
  private list:CampaignListSnapshotV1|null=null;
  private detail:CampaignDetailSnapshotV1|null=null;
  private pending:readonly CampaignPendingV1[]=[];
  private results:CampaignCommandReceiptV1[]=[];
  private journalsReady=false;
  private disposed=false;
  private busy=false;
  private generation=0;
  private editEpoch=0;
  private reader:AbortController|null=null;
  private operation:AbortController|null=null;
  private timer:ReturnType<typeof setTimeout>|null=null;
  private confirming:{phaseId:string;action:'finish'|'stop';target:CampaignTargetV1;repo:string}|null=null;
  constructor(container:HTMLElement,context:PluginPanelContext){
    this.container=container;this.context=context;this.state=context.state;this.storage=new CampaignStorage(context.contributionId,context.state.instanceId);
    try{this.draft=this.storage.draft();}catch(error){this.unsupported=true;this.storageError=message(error,'Saved campaign draft unavailable.');}this.readResults();
    container.addEventListener('input',this.input);container.addEventListener('change',this.change);container.addEventListener('submit',this.submit);container.addEventListener('click',this.click);context.onDispose(this.dispose);context.signal.addEventListener('abort',this.dispose,{once:true});this.state.activity.signal.addEventListener('abort',this.cancel,{once:true});
    if(context.signal.aborted)this.dispose();else{this.draw();void this.refresh();}
  }
  private active(generation=this.generation){return !this.disposed&&!this.context.signal.aborted&&this.state.visible&&this.state.activity.active&&!this.state.activity.signal.aborted&&generation===this.generation;}
  private scopeKey(){return this.state.activity.repo??'*';}
  private inScope(repo:string){return this.state.activity.repo===null||this.state.activity.repo===repo;}
  private creation(){return this.draft.forms[this.scopeKey()]??={name:'',workflowRef:'',concurrency:'1'};}
  private phaseDraft(id=this.detail?.campaign.id):PhaseDraft|null{return id?(this.draft.phases[id]??={name:'',revision:null,imports:{}}):null;}
  private importDraft(phaseId:string):ImportDraft|null{const phase=this.phaseDraft();return phase?(phase.imports[phaseId]??={format:'jsonl',content:'',revision:null}):null;}
  private selected(){return this.draft.selected[this.scopeKey()]??null;}
  private target(revision=this.detail?.revision){return this.detail&&revision?{campaignId:this.detail.campaign.id,revision}:null;}
  private cancelReads(){++this.generation;this.reader?.abort();this.reader=null;if(this.timer)clearTimeout(this.timer);this.timer=null;}
  private cancel=()=>{this.cancelReads();this.operation?.abort();++this.editEpoch;this.confirming=null;this.journalsReady=false;};
  dispose=()=>{if(this.disposed)return;this.disposed=true;this.cancel();this.container.removeEventListener('input',this.input);this.container.removeEventListener('change',this.change);this.container.removeEventListener('submit',this.submit);this.container.removeEventListener('click',this.click);this.context.signal.removeEventListener('abort',this.dispose);this.state.activity.signal.removeEventListener('abort',this.cancel);this.container.replaceChildren();};
  update(next:PluginPanelState){if(this.disposed)return;const previous=this.state;previous.activity.signal.removeEventListener('abort',this.cancel);this.state=next;next.activity.signal.addEventListener('abort',this.cancel,{once:true});const changed=previous.activity!==next.activity||previous.visible!==next.visible;if(changed){this.cancel();if(previous.activity.repo!==next.activity.repo){this.list=null;this.detail=null;this.readError='';this.error='';}void this.refresh();}this.draw();}
  private readResults(){try{this.results=this.storage.results();this.resultsError='';}catch(error){this.resultsError=message(error,'Saved campaign evidence unavailable.');}}
  private persist(){if(this.unsupported)return false;try{this.storage.save('draft',this.draft);this.storageError='';return true;}catch(error){this.storageError=message(error,'Campaign draft could not be saved. Keep this page open.');return false;}}
  private async readPending(signal?:AbortSignal){const values=await this.context.services.campaigns!.pending(signal);if(!Array.isArray(values)||values.length>256||values.some(item=>!item||!inputValid(item.command)||typeof item.command.requestId!=='string'||item.receipt!==null&&(!receiptValid(item.receipt)||item.receipt.requestId!==item.command.requestId)))throw new Error('Campaign journal unavailable. Original requests are kept.');return values;}
  refresh=async()=>{
    if(!this.active()||this.busy)return;this.cancelReads();const generation=this.generation;const reader=new AbortController();this.reader=reader;
    try{const results=await Promise.allSettled([this.context.services.campaigns!.list({version:1,repo:this.state.activity.repo},reader.signal),this.readPending(reader.signal)]);if(!this.active(generation))return;
      const pending=results[1];if(pending.status==='fulfilled'){this.pending=pending.value;this.journalsReady=true;}else{this.journalsReady=false;this.error='Campaign journal unavailable. Original requests are kept.';}
      const result=results[0];if(result.status!=='fulfilled'||result.value?.status!=='available'||!listValid(result.value.value)||result.value.value.repo!==this.state.activity.repo||result.value.value.campaigns.some(campaign=>!this.inScope(campaign.repo)))throw new Error('Campaigns could not be refreshed. Existing drafts are kept.');
      this.list=result.value.value;this.readError='';const creation=this.creation();if(!creation.workflowRef)creation.workflowRef=this.list.workflows[0]?.ref??'';
      let selected=this.selected();if(!selected&&this.list.campaigns[0]){selected={id:this.list.campaigns[0].id,repo:this.list.campaigns[0].repo};this.draft.selected[this.scopeKey()]=selected;}
      if(selected&&this.inScope(selected.repo)&&this.list.campaigns.some(item=>item.id===selected.id&&item.repo===selected.repo)){const result=await this.context.services.campaigns!.detail({version:1,repo:selected.repo,campaignId:selected.id},reader.signal);if(!this.active(generation))return;if(result?.status!=='available'||!detailValid(result.value)||result.value.campaign.id!==selected.id||result.value.campaign.repo!==selected.repo)throw new Error('Campaign details unavailable. Existing drafts are kept.');this.detail=result.value;}
      else this.detail=null;this.readResults();this.draw();
    }catch(error){if(this.active(generation)){this.readError=message(error,'Campaigns unavailable.');this.draw();}}
    finally{if(this.active(generation))this.timer=setTimeout(()=>{void this.refresh();},30_000);}
  };
  private unresolved(){return this.pending.some(item=>this.inScope(item.command.repo));}
  private canMutate(){return this.active()&&!this.busy&&!this.unsupported&&!this.storageError&&!this.resultsError&&!this.readError&&this.journalsReady&&!this.unresolved();}
  private input=(event:Event)=>{
    const control=event.target;if(!(control instanceof HTMLInputElement||control instanceof HTMLSelectElement||control instanceof HTMLTextAreaElement)||this.unsupported||this.busy)return;
    const name=control.name;const creation=this.creation();const phaseId=control.dataset.phaseId;
    if(['name','workflowRef','concurrency'].includes(name)){creation[name as keyof typeof creation]=control.value;}
    else if(name==='phaseName'){const draft=this.phaseDraft();if(draft){draft.name=control.value;draft.revision??=this.detail?.revision??null;}}
    else if(phaseId&&(name==='format'||name==='content')){const draft=this.importDraft(phaseId);if(draft){if(name==='format'&&(control.value==='csv'||control.value==='jsonl'))draft.format=control.value;else if(name==='content')draft.content=control.value;draft.revision??=this.detail?.revision??null;delete this.draft.previews[phaseId];[...this.container.querySelectorAll<HTMLElement>('[data-preview-phase]')].find(row=>row.dataset.previewPhase===phaseId)?.remove();}}
    else return;++this.editEpoch;this.persist();this.paintSafety();
  };
  private change=(event:Event)=>{
    this.input(event);const input=event.target;if(!(input instanceof HTMLInputElement)||!input.dataset.campaignFile||!this.active()||this.unsupported||this.busy)return;const phaseId=input.dataset.campaignFile;const file=input.files?.[0];const detail=this.detail;if(!file||!detail)return;
    if(file.size>1_000_000){this.error='Import must be under 1 MB';this.draw();return;}const epoch=++this.editEpoch;const scope=this.state.activity;const revision=detail.revision;const campaignId=detail.campaign.id;
    void file.text().then(content=>{if(!this.active()||this.busy||scope!==this.state.activity||epoch!==this.editEpoch||this.detail?.campaign.id!==campaignId)return;if(new TextEncoder().encode(content).byteLength>1_000_000)throw new Error('Import must be under 1 MB');const phase=this.detail.phases.find(row=>row.phase.id===phaseId)?.phase;if(!phase||!['draft','paused'].includes(phase.state))return;const draft=this.importDraft(phaseId);if(!draft)return;draft.content=content;draft.format=file.name.toLowerCase().endsWith('.csv')?'csv':'jsonl';draft.revision=revision;delete this.draft.previews[phaseId];this.persist();this.draw();}).catch(error=>{if(this.active()&&scope===this.state.activity&&epoch===this.editEpoch){this.error=message(error,'Unable to read import file');this.draw();}});
  };
  private submit=(event:Event)=>{
    const form=event.target;if(!(form instanceof HTMLFormElement))return;event.preventDefault();event.stopPropagation();if(!this.canMutate())return;
    if(form.hasAttribute('data-campaign-create')){const repo=this.state.activity.repo;const draft=this.creation();const concurrency=Number(draft.concurrency);if(!repo||!draft.name.trim()||!Number.isInteger(concurrency)||concurrency<1||concurrency>20||!this.list?.workflows.some(item=>item.ref===draft.workflowRef)){this.error='Choose a repository, campaign name, available workflow, and concurrency from 1 to 20.';this.draw();return;}void this.command({version:1,repo,action:'create',name:draft.name,workflowRef:draft.workflowRef,concurrency});}
    else if(form.dataset.campaignPhaseCreate&&this.detail){const draft=this.phaseDraft();const target=this.target(draft?.revision??this.detail.revision);if(draft?.name.trim()&&target)void this.command({version:1,repo:this.detail.campaign.repo,action:'add-phase',target,name:draft.name});}
    else if(form.dataset.campaignImport&&this.detail){const phaseId=form.dataset.campaignImport;const draft=this.importDraft(phaseId);const target=this.target(draft?.revision??this.detail.revision);if(draft?.content.trim()&&target)void this.command({version:1,repo:this.detail.campaign.repo,action:'preview',target,phaseId,format:draft.format,content:draft.content});}
  };
  private click=(event:MouseEvent)=>{
    const button=event.target instanceof Element?event.target.closest<HTMLButtonElement>('button'):null;if(!button||button.disabled||!this.active())return;event.stopPropagation();
    if(button.hasAttribute('data-campaign-refresh')){void this.refresh();return;}if(button.hasAttribute('data-save-draft')){this.persist();this.draw();return;}
    if(button.hasAttribute('data-scope-all')||button.hasAttribute('data-scope-inherit')){this.cancel();void this.context.setScope?.({kind:button.hasAttribute('data-scope-all')?'all':'inherit'}).catch(error=>{this.error=message(error,'Campaign scope unavailable.');this.draw();});return;}
    if(button.dataset.campaignSelect){const campaign=this.list?.campaigns.find(row=>row.id===button.dataset.campaignSelect);if(!campaign)return;this.cancelReads();++this.editEpoch;this.draft.selected[this.scopeKey()]={id:campaign.id,repo:campaign.repo};this.detail=null;this.confirming=null;this.persist();this.draw();void this.refresh();return;}
    if(button.dataset.campaignOpenRun&&button.dataset.runRepo){const header=this.state.headerRepo===undefined?this.state.repo:this.state.headerRepo;this.context.navigate(`/runs?${new URLSearchParams({...(header?{repo:header}:{}),runRepo:button.dataset.runRepo,run:button.dataset.campaignOpenRun})}`);return;}
    if(button.dataset.requestId){void this.reconcile(button.dataset.requestId,button.hasAttribute('data-retry'));return;}
    if(button.hasAttribute('data-campaign-dismiss')){const choice=this.confirming;this.confirming=null;this.draw();const trigger=[...this.container.querySelectorAll<HTMLButtonElement>('[data-campaign-action]')].find(control=>control.dataset.campaignAction===choice?.action&&control.dataset.phaseId===choice?.phaseId);if(trigger&&!trigger.matches(':disabled'))trigger.focus({preventScroll:true});return;}if(button.hasAttribute('data-campaign-dismiss-preview')){const phaseId=button.closest<HTMLElement>('[data-preview-phase]')?.dataset.previewPhase;if(phaseId)delete this.draft.previews[phaseId];this.persist();this.draw();return;}
    if(button.dataset.rebasePhase&&this.detail){const phase=this.phaseDraft();const draft=phase?.imports[button.dataset.rebasePhase];if(draft){draft.revision=this.detail.revision;delete this.draft.previews[button.dataset.rebasePhase];}this.persist();this.draw();return;}
    if(button.hasAttribute('data-rebase-name')&&this.detail){const draft=this.phaseDraft();if(draft)draft.revision=this.detail.revision;this.persist();this.draw();return;}
    if(!this.canMutate()||!this.detail)return;const target=this.target()!;const repo=this.detail.campaign.repo;const action=button.dataset.campaignAction;const phaseId=button.dataset.phaseId;
    if((action==='finish'||action==='stop')&&phaseId){this.confirming={phaseId,action,target,repo};this.draw();this.container.querySelector<HTMLElement>('[data-campaign-dismiss]')?.focus({preventScroll:true});return;}
    if(action&&phaseId&&['start','pause','resume'].includes(action)){void this.command({version:1,repo,action:'phase',target,phaseId,operation:action as CampaignPhaseActionV1});return;}
    if(button.hasAttribute('data-campaign-confirm-action')&&this.confirming){const choice=this.confirming;void this.command({version:1,repo:choice.repo,action:'phase',target:choice.target,phaseId:choice.phaseId,operation:choice.action});}
    else if(button.dataset.campaignConfirmImport){const preview=Object.values(this.draft.previews).find(row=>row.preview.id===button.dataset.campaignConfirmImport&&row.target.campaignId===this.detail?.campaign.id);if(preview)void this.command({version:1,repo:preview.repo,action:'confirm',target:preview.target,previewId:preview.preview.id,digest:preview.preview.digest});}
    else if(button.dataset.campaignRetry){const task=this.detail.phases.flatMap(row=>row.tasks).find(task=>task.id===button.dataset.campaignRetry);if(task)void this.command({version:1,repo,action:'retry-task',target,taskId:task.id,expectedAttempt:task.attempt});}
  };
  private async command(input:CampaignCommandInputV1){
    if(!this.canMutate()||!this.persist())return;this.busy=true;this.error='';this.operation=new AbortController();const signal=AbortSignal.any([this.operation.signal,this.context.signal,this.state.activity.signal]);this.draw();
    try{this.pending=await this.readPending(signal);if(signal.aborted||!this.active()||this.unresolved())throw new Error('Reconcile the original campaign request before another mutation.');const result=await this.context.services.campaigns!.submit(input,signal);if(result?.status!=='available'||!receiptValid(result.value)||JSON.stringify(result.value.input)!==JSON.stringify(input))throw new Error('Campaign result unavailable. Check or retry the retained original request.');await this.consume(result.value);}
    catch(error){this.error=message(error,'Campaign action unavailable. Original evidence is kept.');}
    finally{try{this.pending=await this.readPending();this.journalsReady=true;}catch{this.journalsReady=false;}this.busy=false;this.operation=null;this.draw();void this.refresh();}
  }
  private async consume(value:CampaignCommandReceiptV1){
    if(!receiptValid(value))throw new Error('Invalid campaign receipt. Original evidence is kept.');this.storage.result(value);this.readResults();if(this.resultsError)throw new Error(this.resultsError);
    if(value.status==='succeeded'&&value.result){const input=value.input;const result=value.result;
      if(input.action==='create'&&result.kind==='created'&&campaignValid(result.campaign)){const form=this.draft.forms[input.repo];if(form?.name===input.name&&form.workflowRef===input.workflowRef&&Number(form.concurrency)===input.concurrency)form.name='';this.draft.selected[input.repo]={id:result.campaign.id,repo:result.campaign.repo};}
      if(input.action==='add-phase'){const phase=this.draft.phases[input.target.campaignId];if(phase?.name===input.name){phase.name='';phase.revision=null;}}
      if(input.action==='preview'&&result.kind==='preview'){const draft=this.draft.phases[input.target.campaignId]?.imports[input.phaseId];if(draft?.content===input.content&&draft.format===input.format){for(const[key,preview]of Object.entries(this.draft.previews))if(preview.target.campaignId===input.target.campaignId)delete this.draft.previews[key];this.draft.previews[input.phaseId]={repo:input.repo,target:input.target,preview:result.preview,content:input.content,format:input.format};}}
      if(input.action==='confirm'){const entry=Object.entries(this.draft.previews).find(([,value])=>value.preview.id===input.previewId);if(entry){const [phaseId,preview]=entry;const draft=this.draft.phases[preview.target.campaignId]?.imports[phaseId];if(draft?.content===preview.content&&draft.format===preview.format){draft.content='';draft.revision=null;}delete this.draft.previews[phaseId];}}
      if(input.action==='phase'&&this.confirming?.phaseId===input.phaseId)this.confirming=null;
      if(!this.persist())throw new Error(this.storageError||'Campaign result could not be retained with the current drafts.');
    }
    this.error=value.status==='rejected'?value.reason??'Campaign request rejected. Your draft and original revision are kept.':'';
    await this.context.services.campaigns!.acknowledge({repo:value.input.repo,requestId:value.requestId});
  }
  private async reconcile(requestId:string,retry:boolean){
    if(this.busy||!this.active())return;const original=this.pending.find(row=>row.command.requestId===requestId);if(!original)return;this.busy=true;this.operation=new AbortController();const signal=AbortSignal.any([this.operation.signal,this.context.signal,this.state.activity.signal]);this.draw();
    try{const service=this.context.services.campaigns!;const query={repo:original.command.repo,requestId};const result=retry?await service.retry(query,signal):await service.receipt(query,signal);const {requestId:_,...input}=original.command;if(result?.status!=='available'||!result.value||!receiptValid(result.value)||result.value.requestId!==requestId||JSON.stringify(result.value.input)!==JSON.stringify(input))throw new Error('Original campaign receipt unavailable. Its identity is kept.');await this.consume(result.value);}
    catch(error){this.error=message(error,'Original campaign receipt unavailable.');}
    finally{try{this.pending=await this.readPending();this.journalsReady=true;}catch{this.journalsReady=false;}this.busy=false;this.operation=null;this.draw();void this.refresh();}
  }
  private fieldKey(control:HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement){if(control.dataset.campaignFile)return `file:${control.dataset.campaignFile}`;return `${control.closest('[data-campaign-create]')?'create':this.detail?.campaign.id??''}:${control.dataset.phaseId??''}:${control.name}`;}
  private paintSafety(){const disabled=!this.canMutate();for(const fieldset of this.container.querySelectorAll<HTMLFieldSetElement>('fieldset'))fieldset.disabled=this.busy||this.unsupported||!this.active()||(fieldset.closest('[data-campaign-create]')!==null&&(!this.state.activity.repo||!this.list?.workflows.length));for(const button of this.container.querySelectorAll<HTMLButtonElement>('button[type="submit"],[data-campaign-action],[data-campaign-confirm-action],[data-campaign-confirm-import],[data-campaign-retry]')){button.disabled=disabled||button.closest('[data-campaign-create]')!==null&&(!this.state.activity.repo||!this.list?.workflows.some(item=>item.ref===this.creation().workflowRef))||button.dataset.campaignAction==='start'&&!this.detail?.phases.find(row=>row.phase.id===button.dataset.phaseId)?.tasks.length;}for(const button of this.container.querySelectorAll<HTMLButtonElement>('[data-request-id]'))button.disabled=this.busy||!this.active()||!!this.resultsError;const error=this.container.querySelector('[data-storage-error]');if(error)error.textContent=[this.storageError,this.resultsError].filter(Boolean).join(' ');}
  private draw(){
    if(this.disposed)return;const creation=this.creation();const phase=this.phaseDraft();const preview=Object.values(this.draft.previews).find(row=>row.target.campaignId===this.detail?.campaign.id)?.preview??null;
    const retained=new Map<string,HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>();for(const control of this.container.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>('input,select,textarea'))retained.set(this.fieldKey(control),control);const focused=document.activeElement instanceof HTMLElement&&this.container.contains(document.activeElement)?document.activeElement:null;const selection=focused instanceof HTMLInputElement||focused instanceof HTMLTextAreaElement?[focused.selectionStart,focused.selectionEnd]as const:null;
    const openDetails=new Map([...this.container.querySelectorAll<HTMLDetailsElement>('details')].map(row=>[row.querySelector<HTMLElement>('summary')?.dataset.focusKey,row.open]));const scrolls=[...this.container.querySelectorAll<HTMLElement>('.campaign-table-wrap,.campaign-preview ol')].map(row=>row.scrollLeft);
    const template=document.createElement('template');template.innerHTML=`<style>${styles}</style><div class="campaign-scope"><button data-scope-inherit>Use header scope</button><button data-scope-all>Show all campaigns</button><span>Scope: ${esc(this.state.activity.repo??'All campaigns')}</span><button data-save-draft>Save drafts</button><p class="campaign-error" role="alert" data-storage-error></p></div>`+renderCampaigns({pirateMode:this.state.pirateMode,repo:this.state.activity.repo,list:this.list??{campaigns:[],workflows:[]},detail:this.detail,preview,busy:this.busy,error:[this.readError,this.error].filter(Boolean).join(' ')||null,name:creation.name,phaseName:phase?.name??'',concurrency:creation.concurrency,workflowRef:creation.workflowRef,imports:phase?.imports??{},confirming:this.confirming});
    for(const control of template.content.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>('input,select,textarea')){const previous=retained.get(this.fieldKey(control));if(!previous||previous.tagName!==control.tagName||(previous instanceof HTMLInputElement&&control instanceof HTMLInputElement&&previous.type!==control.type))continue;if(previous instanceof HTMLSelectElement&&control instanceof HTMLSelectElement&&previous.innerHTML!==control.innerHTML)previous.innerHTML=control.innerHTML;if(!(previous instanceof HTMLInputElement&&previous.type==='file')&&previous.value!==control.value)previous.value=control.value;control.replaceWith(previous);}
    if(preview){const section=template.content.querySelector<HTMLElement>('.campaign-preview');if(section)section.dataset.previewPhase=preview.phaseId;}
    const detail=template.content.querySelector('.campaign-detail');if(detail&&this.detail){if(phase?.revision&&phase.revision!==this.detail.revision){const row=document.createElement('p');row.className='campaign-error';row.innerHTML='The phase-name draft retains an older revision. <button data-rebase-name>Use latest revision for phase name</button>';detail.prepend(row);}for(const[phaseId,draft]of Object.entries(phase?.imports??{}))if(draft.revision&&draft.revision!==this.detail.revision){const form=[...template.content.querySelectorAll<HTMLFormElement>('[data-campaign-import]')].find(form=>form.dataset.campaignImport===phaseId);const row=document.createElement('p');row.className='campaign-error';row.innerHTML=`This import retains its original revision. <button data-rebase-phase="${esc(phaseId)}">Use latest revision and preview again</button>`;form?.prepend(row);}}
    const recovery=document.createElement('section');recovery.className='campaign-recovery';for(const item of this.pending.filter(item=>this.inScope(item.command.repo))){const article=document.createElement('article');article.innerHTML=`<h3>${esc(item.command.action)} · ${esc(item.command.repo)} · ${esc(item.receipt?.status??'Uncertain result')}</h3><code>${esc(item.command.requestId)}</code><p>Original input is retained. Checking or retrying uses this request identity.</p><button data-request-id="${esc(item.command.requestId)}">Check original receipt</button><button data-request-id="${esc(item.command.requestId)}" data-retry>Retry original request</button>`;recovery.append(article);}const results=document.createElement('details');results.innerHTML=`<summary>Saved campaign results</summary>${this.results.filter(row=>this.inScope(row.input.repo)).slice(-50).map(row=>`<article>${esc(row.input.action)} · ${esc(row.status)} · ${esc(row.reason)}<br><code>${esc(row.requestId)}</code></article>`).join('')}`;recovery.append(results);template.content.append(recovery);
    for(const control of template.content.querySelectorAll<HTMLElement>('button,summary')){
      const form=control.closest<HTMLFormElement>('form');
      const attributes=[...control.attributes].filter(attribute=>attribute.name.startsWith('data-')).map(attribute=>[attribute.name,attribute.value]);
      control.dataset.focusKey=JSON.stringify([this.scopeKey(),control.closest('.campaign-detail')?this.detail?.campaign.id:null,control.tagName,attributes,form?[...form.attributes].filter(attribute=>attribute.name.startsWith('data-')).map(attribute=>[attribute.name,attribute.value]):null,control.tagName==='SUMMARY'?control.textContent:null]);
    }
    this.container.replaceChildren(template.content);[...this.container.querySelectorAll<HTMLDetailsElement>('details')].forEach(row=>{row.open=openDetails.get(row.querySelector<HTMLElement>('summary')?.dataset.focusKey)??false;});[...this.container.querySelectorAll<HTMLElement>('.campaign-table-wrap,.campaign-preview ol')].forEach((row,index)=>{row.scrollLeft=scrolls[index]??0;});this.paintSafety();
    if(focused){
      const replacement=focused.isConnected?focused:[...this.container.querySelectorAll<HTMLElement>('[data-focus-key]')].find(control=>control.dataset.focusKey===focused.dataset.focusKey);
      const fallback=this.container.querySelector<HTMLElement>('[data-campaign-refresh]:not(:disabled)')??this.container.querySelector<HTMLElement>('.campaign-page');
      const target=replacement&&!replacement.matches(':disabled')?replacement:fallback;
      if(target){if(target.classList.contains('campaign-page'))target.tabIndex=-1;target.focus({preventScroll:true});}
      if(selection&&target===focused&&(focused instanceof HTMLInputElement||focused instanceof HTMLTextAreaElement)&&focused.type!=='number'&&focused.type!=='file')focused.setSelectionRange(...selection);
    }
  }
}
const panel:PluginPanelModule={mount(container,context){if(context.services.campaigns?.version!==1)throw new Error('Campaigns require version 1 public campaigns services.');return new CampaignPanel(container,context);}};
export default panel;

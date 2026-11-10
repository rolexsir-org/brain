// Automation Control Centre — inspect services/permissions/automations/scheduled/pending approvals/failed/recent activity

import { nodes as E } from '../util/util.js';
import { entityCard } from './cards.js';
import { getCaps } from '../caps.js';

function automationStatus(store){
  const ig = store.settings?.instagram?.automation;
  if (!ig) return { enabled:false, paused:false, mode:'MANUAL', count:0 };
  return { enabled: !!ig.enabled, paused: !!ig.paused, mode: ig.mode||'MANUAL', count: (ig.rules||[]).length, history: ig.history||[] };
}

export function openAutomationCentre(ctx) {
  const body=document.getElementById('sheetBody');
  const titleEl=document.getElementById('sheetTitle');
  if(!body||!titleEl) return;
  titleEl.textContent='Automation Centre';
  body.textContent='';

  const store=ctx.store;
  const caps=getCaps();
  body.append(E.div({class:'banner'},'Inspect what Brain can do on your behalf — permissions, scheduled automations, pending approvals, and recent activity. You can pause or disable anything here.'));

  // Services grid
  const services = [
    { name:'Notifications', active: caps.notifications.supported && caps.notifications.permission==='granted', purpose:'Reminders and briefings', boundary:'Only this device; no cloud push', pause: ()=>{} },
    { name:'Instagram', active: store.settings.instagram?.connected, purpose:'Publish Reels you approve', boundary:'Only explicit publish; automation requires separate opt-in', pause: async()=>{ await ctx.runAction({id:'instagram.disconnect', args:{}}); } },
    { name:'Location', active: caps.geolocation.supported, purpose:'Open Maps once per tap', boundary:'Never background tracking', pause: null },
    { name:'Contacts', active: caps.contacts.select, purpose:'Import contacts you select', boundary:'Read-only; Brain never writes to system contacts', pause: null },
    { name:'Camera/Files', active: caps.files.picker, purpose:'Choose photos/videos', boundary:'Local only until you publish', pause: null },
  ];
  body.append(E.div({class:'tt'},'Connected services & permissions'));
  for(const svc of services){
    const row=E.div({class:'srow'});
    row.append(E.div({class:'em', style: svc.active ? 'background:#e0f5e9' : 'background:#f3f4f6'}, svc.active?'●':'○'), E.div({class:'tx'}, E.b({}, svc.name + (svc.active?' · active':' · inactive')), E.small({}, `${svc.purpose}. Boundary: ${svc.boundary}`)));
    if(svc.pause) {
      const pauseBtn=E.button({class:'ghost', type:'button'},'Disable');
      pauseBtn.addEventListener('click', async()=>{ if(window.confirm(`Disable ${svc.name}?`)) await svc.pause(); openAutomationCentre(ctx); });
      row.append(pauseBtn);
    }
    body.append(row);
  }
  body.append(E.div({class:'hr'}));

  // Instagram automation
  const igAuto = automationStatus(store);
  body.append(E.div({class:'tt'},'Instagram automations'));
  body.append(E.div({class:'note'}, igAuto.enabled ? (igAuto.paused ? 'Automation enabled but PAUSED' : `Mode: ${igAuto.mode} · ${igAuto.count} rule(s)`) : 'Automation disabled — publishing requires manual approval (Mode 1)'));
  const autoRow=E.div({class:'actbar'});
  const openAutoBtn=E.button({class:'primary', type:'button'}, igAuto.enabled ? 'Manage automation' : 'Configure automation');
  openAutoBtn.addEventListener('click', ()=> openInstagramAutomationPanel(ctx));
  autoRow.append(openAutoBtn);
  if(igAuto.enabled && !igAuto.paused){
    const pauseBtn=E.button({class:'ghost danger', type:'button'},'⏸ Pause automation');
    pauseBtn.addEventListener('click', async()=>{
      const { pauseAutomation } = await import('../instagram/automation.js');
      const updated = pauseAutomation(store.settings.instagram.automation);
      await store.updateSettings({ instagram: { ...store.settings.instagram, automation: updated } });
      ctx.toast('Automation paused — manual approval required.');
      openAutomationCentre(ctx);
    });
    autoRow.append(pauseBtn);
  } else if(igAuto.paused){
    const resumeBtn=E.button({class:'ghost', type:'button'},'▶ Resume');
    resumeBtn.addEventListener('click', async()=>{
      const { resumeAutomation } = await import('../instagram/automation.js');
      const updated = resumeAutomation(store.settings.instagram.automation);
      await store.updateSettings({ instagram: { ...store.settings.instagram, automation: updated } });
      ctx.toast('Automation resumed.');
      openAutomationCentre(ctx);
    });
    autoRow.append(resumeBtn);
  }
  body.append(autoRow);

  // Scheduled automations (display as cards)
  const scheduled = store.list('reminder').filter(r=> r.status==='active').slice(0,10);
  if(scheduled.length){
    body.append(E.div({class:'tt', style:'margin-top:12px'},'Scheduled (timed) automations'));
    for(const r of scheduled){ const card=entityCard(ctx,'reminder', r.id); if(card) body.append(card); }
  }

  body.append(E.div({class:'hr'}));

  // Pending approvals
  body.append(E.div({class:'tt'},'Pending approvals'));
  const pending = store.list('instagramDraft').filter(d=> ['AWAITING_APPROVAL','READY','SCHEDULED'].includes(String(d.status).toUpperCase()));
  if(!pending.length) body.append(E.div({class:'note'},'No Reels awaiting approval.'));
  else for(const d of pending){
    const card=entityCard(ctx,'instagramDraft', d.id); if(card) body.append(card);
  }

  // Failed items
  const failed = store.list('instagramDraft').filter(d=> String(d.status).toUpperCase()==='FAILED').slice(0,10);
  if(failed.length){
    body.append(E.div({class:'tt', style:'margin-top:10px'},'Failed — can retry'));
    for(const f of failed){ const card=entityCard(ctx,'instagramDraft', f.id); if(card) body.append(card); }
  }

  // Recent activity (last 20 history from automations + publications)
  const acts=[];
  const igHist = igAuto.history || [];
  for(const h of igHist.slice(0,20)) acts.push({ at:h.at, text:`${h.action} · ${h.result||''} ${h.error? '— '+h.error.slice(0,60):''}`, source:'Instagram automation' });
  const pubs = store.list('instagramPublication').slice(-10);
  for(const p of pubs) acts.push({ at:p.publishedAt, text:`Published Reel: ${p.videoName}`, source:'Instagram' });
  acts.sort((a,b)=> String(b.at).localeCompare(String(a.at)));
  body.append(E.div({class:'hr'}), E.div({class:'tt'},'Recent activity'));
  if(!acts.length) body.append(E.div({class:'note'},'No recent automation activity.'));
  else for(const a of acts.slice(0,20)) {
    body.append(E.div({class:'diag'}, E.div({class:'dn'}, a.source), E.div({class:'dv'}, `${new Date(a.at).toLocaleString()} — ${a.text.slice(0,100)}`)));
  }

  // History controls
  body.append(E.div({class:'hr'}));
  body.append(E.div({class:'note'},'Every automation shows its purpose, boundary, and pause/disable control above. History is kept locally — never sent elsewhere.'));
  openSheetPanel();
}

async function openInstagramAutomationPanel(ctx){
  const body=document.getElementById('sheetBody');
  const titleEl=document.getElementById('sheetTitle');
  titleEl.textContent='Instagram Automation';
  body.textContent='';

  const store=ctx.store;
  const a = store.settings.instagram.automation || { enabled:false, mode:'MANUAL', rules:[], paused:false, history:[] };
  body.append(E.div({class:'banner'},'Mode 2 automation: Brain will only auto-publish videos you explicitly authorize here. General connection NEVER grants publish-all.'));

  // Mode toggle
  const modeWrap=E.div({class:'field'});
  const modeSelect=E.select({}, E.option({value:'MANUAL', selected: a.mode==='MANUAL'||!a.enabled? true:null },'Manual — approval required (default)'), E.option({value:'AUTOMATED', selected: a.mode==='AUTOMATED'&&a.enabled? true:null},'Automated — only eligible videos per rules below'));
  modeWrap.append(E.label({},'Publishing mode'), modeSelect);
  body.append(modeWrap);

  // Rules list
  body.append(E.div({class:'tt', style:'margin-top:12px'},'Automation rules — define which videos are eligible'));
  body.append(E.div({class:'note'},'Each rule lists specific Draft IDs or matching criteria. No rule means no auto-publish — ever.'));
  for(const rule of (a.rules||[])){
    const row=E.div({class:'srow'});
    row.append(E.div({class:'em'}, rule.enabled?'✓':'○'), E.div({class:'tx'}, E.b({}, rule.name||'Untitled rule'), E.small({}, `Eligible: ${(rule.filters?.eligibleDraftIds||[]).length} drafts · Tags: ${(rule.filters?.tags||[]).join(', ')||'—'} · ${rule.schedule?.time||'09:00'}`)));
    const editBtn=E.button({class:'ghost', type:'button'},'Edit');
    editBtn.addEventListener('click', ()=> editRule(ctx, rule.id));
    const delBtn=E.button({class:'ghost danger', type:'button'},'Delete');
    delBtn.addEventListener('click', async()=>{
      if(!window.confirm(`Delete rule “${rule.name}”?`)) return;
      const updated={...a, rules: a.rules.filter(r=> r.id!==rule.id)};
      await store.updateSettings({ instagram:{...store.settings.instagram, automation: updated}});
      openInstagramAutomationPanel(ctx);
    });
    const toggleBtn=E.button({class:'ghost', type:'button'}, rule.enabled?'Disable':'Enable');
    toggleBtn.addEventListener('click', async()=>{
      const updated={...a, rules: a.rules.map(r=> r.id===rule.id? {...r, enabled:!r.enabled}:r)};
      await store.updateSettings({ instagram:{...store.settings.instagram, automation: updated}});
      openInstagramAutomationPanel(ctx);
    });
    row.append(editBtn, toggleBtn, delBtn);
    body.append(row);
  }

  const addRuleBtn=E.button({class:'primary', type:'button', style:'margin-top:8px'},'+ Add rule');
  addRuleBtn.addEventListener('click', async()=>{
    const name=prompt('Rule name (e.g. “Weekly highlights”):');
    if(!name) return;
    const { makeRule } = await import('../instagram/automation.js');
    const rule=makeRule({ name, filters:{ eligibleDraftIds:[] }, schedule:{ time:'09:00', freq:'daily' }});
    const updated={...a, rules: [...(a.rules||[]), rule]};
    await store.updateSettings({ instagram:{...store.settings.instagram, automation: updated}});
    openInstagramAutomationPanel(ctx);
  });
  body.append(addRuleBtn);

  // Save
  const saveBtn=E.button({class:'primary', type:'button', style:'margin-top:14px'},'Save automation settings');
  saveBtn.addEventListener('click', async()=>{
    const mode=modeSelect.value;
    const enabled = mode==='AUTOMATED';
    const updated={ ...a, mode, enabled, paused: enabled? a.paused:false };
    await store.updateSettings({ instagram:{...store.settings.instagram, automation: updated}});
    ctx.toast(enabled? 'Automation enabled — only eligible videos per rules will auto-publish.':'Automation set to manual — approval required.');
    openAutomationCentre(ctx);
  });
  body.append(saveBtn);
  body.append(E.button({class:'ghost', type:'button', onclick: ()=> openAutomationCentre(ctx)},'← Back'));

  if(!a.rules || !a.rules.length){
    body.append(E.div({class:'note', style:'margin-top:10px'},'No rules yet. Click “Add rule” to select which Reels are eligible for auto-publishing. Until you do, nothing will auto-publish.'));
  }
  openSheetPanel();
}

async function editRule(ctx, ruleId){
  const store=ctx.store;
  const automation=store.settings.instagram.automation;
  const rule=(automation.rules||[]).find(r=>r.id===ruleId);
  if(!rule) return;
  const body=document.getElementById('sheetBody');
  const titleEl=document.getElementById('sheetTitle');
  titleEl.textContent=`Edit rule: ${rule.name}`;
  body.textContent='';

  const nameInput=E.input({value:rule.name, class:'ed', placeholder:'Rule name'});
  body.append(E.div({class:'field'}, E.label({},'Rule name'), nameInput));

  const tagsInput=E.input({value:(rule.filters.tags||[]).join(', '), class:'ed', placeholder:'Comma-separated tags (must match draft hashtags)'});
  body.append(E.div({class:'field'},E.label({},'Required hashtags (draft must have one)'), tagsInput));

  const patternInput=E.input({value: rule.filters.namePattern||'', class:'ed', placeholder:'Substring to match in video name'});
  body.append(E.div({class:'field'},E.label({},'Video name pattern'), patternInput));

  body.append(E.div({class:'tt'},'Eligible drafts — explicitly tick which videos this rule may publish'));
  body.append(E.div({class:'note'},'Only these draft IDs will be considered — never “all videos”.'));
  const drafts=store.list('instagramDraft');
  for(const d of drafts){
    const cb=E.input({type:'checkbox'});
    cb.checked=(rule.filters.eligibleDraftIds||[]).includes(d.id);
    cb.dataset.draftId=d.id;
    const row=E.div({class:'srow'}, cb, E.div({class:'tx'},E.b({}, d.videoName||'Reel'),E.small({}, `${d.status} · ${d.videoName}`)));
    row.addEventListener('click', (e)=>{ if(e.target!==cb) cb.checked=!cb.checked; });
    body.append(row);
  }

  const saveBtn=E.button({class:'primary', type:'button', style:'margin-top:12px'},'Save rule');
  saveBtn.addEventListener('click', async()=>{
    const updatedRules=automation.rules.map(r=> r.id!==ruleId? r : {
      ...r,
      name: nameInput.value.trim()||r.name,
      filters: {
        ...r.filters,
        tags: tagsInput.value.split(',').map(s=>s.trim()).filter(Boolean),
        namePattern: patternInput.value.trim(),
        eligibleDraftIds: [...body.querySelectorAll('input[type=checkbox]')].filter(cb=> cb.checked).map(cb=> cb.dataset.draftId).filter(Boolean)
      },
      updatedAt: new Date().toISOString()
    });
    await store.updateSettings({ instagram:{...store.settings.instagram, automation:{...automation, rules: updatedRules}}});
    ctx.toast('Rule saved.');
    openInstagramAutomationPanel(ctx);
  });
  body.append(saveBtn);
  body.append(E.button({class:'ghost', type:'button', onclick: ()=> openInstagramAutomationPanel(ctx)},'Cancel'));
  openSheetPanel();
}

function openSheetPanel(){
  try { document.dispatchEvent(new CustomEvent('brain:sheet-open')); } catch {}
  const sheet=document.getElementById('sheet');
  if(sheet){ sheet.classList.add('open'); sheet.setAttribute('aria-hidden','false'); }
}

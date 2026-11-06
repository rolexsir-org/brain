// Personal Command Centre — unified search across records, tasks↔events, reminders↔tasks, expenses/debts/inventory/notes/journal/content calendar

import { nodes as E, escHtml } from '../util/util.js';
import { searchAll } from '../engine/search.js';
import { entityCard } from './cards.js';

function tasksToEvents(store) {
  // Show draft tasks that have due dates alongside calendar events
  const tasks = store.list('task').filter(t=> t.due && t.status!=='done');
  const events = store.list('event');
  return [...tasks.map(t=> ({ kind:'task', id:t.id, at:t.due, title:t.title })), ...events.map(ev=> ({ kind:'event', id:ev.id, at:ev.at, title:ev.title }))]
    .filter(x=> x.at)
    .sort((a,b)=> new Date(a.at)-new Date(b.at));
}

function remindersToTasks(store) {
  const rems = store.list('reminder').filter(r=> r.status==='active');
  const tasks = store.list('task').filter(t=> t.status!=='done');
  return { reminders: rems.slice(0,20), tasks: tasks.slice(0,20) };
}

function pendingActions(store) {
  const items=[];
  for (const t of store.list('task')) if (t.status!=='done') items.push({ kind:'task', record:t, due:t.due });
  for (const r of store.list('reminder')) if (r.status==='active') items.push({ kind:'reminder', record:r, due:r.at||r.nextAt });
  for (const d of store.list('instagramDraft')) if (['READY','AWAITING_APPROVAL','FAILED','SCHEDULED'].includes(String(d.status).toUpperCase())) items.push({ kind:'instagramDraft', record:d, due:d.scheduledAt });
  return items.sort((a,b)=> {
    const da = a.due ? new Date(a.due).getTime() : Infinity;
    const db = b.due ? new Date(b.due).getTime() : Infinity;
    return da-db;
  }).slice(0,30);
}

export function openCommandCentre(ctx) {
  const body = document.getElementById('sheetBody');
  const titleEl = document.getElementById('sheetTitle');
  if (!body || !titleEl) return;
  titleEl.textContent = 'Command Centre';
  body.textContent='';

  const banner = E.div({ class:'banner' }, 'Your personal command centre — everything in one place. Use the search below or explore pending actions, calendar, expenses, and more.');
  body.append(banner);

  // search bar
  const searchWrap = E.div({ class:'field' });
  const input = E.input({ type:'search', placeholder:'Find anything… (tasks, notes, people, journal, Reels)', class:'ed', style:'margin-top:8px' });
  const results = E.div({ class:'cards', style:'margin-top:8px' });
  searchWrap.append(E.label({}, 'Quick find'), input, E.div({ class:'note' }, 'Natural language: “find my meeting notes from last week”, “show expenses for March”'), results);
  body.append(searchWrap);

  const debounced = (()=>{ let t; return fn => { clearTimeout(t); t=setTimeout(fn,300); }; })();
  input.addEventListener('input', ()=> debounced(async ()=>{
    const q = input.value.trim();
    if (!q) { results.textContent=''; return; }
    const hits = searchAll(q, ctx.store);
    results.textContent='';
    if (!hits.length) { results.append(E.div({class:'note'}, `No results for “${q}”`)); return; }
    results.append(E.div({class:'note'}, `${hits.length} result${hits.length===1?'':'s'} for “${q}”`));
    for (const h of hits.slice(0,20)) {
      const card = entityCard(ctx, h.type, h.record.id);
      if (card) results.append(card);
    }
    // Also surface pending actions contextually
    if (/pending|overdue|today|upcoming/i.test(q)) {
      const p = pendingActions(ctx.store);
      if (p.length) { results.append(E.div({class:'hr'}), E.div({class:'tt'},'Pending actions'), ...p.map(x=> entityCard(ctx, x.kind, x.record.id)).filter(Boolean)); }
    }
  }));

  // Tabs / sections
  const sections = [
    { label:'Pending actions', render: () => {
      const box = E.div({});
      const list = pendingActions(ctx.store);
      if (!list.length) box.append(E.div({class:'note'},'No pending tasks, reminders, or drafts. Take a breath.'));
      else for (const item of list) { const c=entityCard(ctx, item.kind, item.record.id); if(c) box.append(c); }
      return box;
    }},
    { label:'Tasks ↔ Events', render: () => {
      const box = E.div({});
      const items = tasksToEvents(ctx.store).slice(0,20);
      if (!items.length) box.append(E.div({class:'note'},'No tasks or events with dates.'));
      else {
        for (const it of items) {
          const card = entityCard(ctx, it.kind, it.id);
          if(card) box.append(card);
        }
        box.append(E.div({class:'note'},'Tasks with due dates appear alongside calendar events for unified planning.'));
      }
      return box;
    }},
    { label:'Reminders ↔ Tasks', render: ()=>{
      const box=E.div({});
      const { reminders, tasks } = remindersToTasks(ctx.store);
      box.append(E.div({class:'tt'},'Reminders'), E.div({class:'note'},`${reminders.length} active`));
      for(const r of reminders.slice(0,8)){ const c=entityCard(ctx,'reminder',r.id); if(c) box.append(c); }
      box.append(E.div({class:'tt', style:'margin-top:10px'},'Open tasks'), E.div({class:'note'},`${tasks.length} open`));
      for(const t of tasks.slice(0,8)){ const c=entityCard(ctx,'task',t.id); if(c) box.append(c); }
      return box;
    }},
    { label:'Money · Debts · Stock', render: ()=>{
      const box=E.div({});
      const money = ctx.store.list('money').slice().sort((a,b)=> String(b.date).localeCompare(String(a.date))).slice(0,10);
      const debts = ctx.store.list('debt').filter(d=>d.status!=='settled').slice(0,10);
      const stock = ctx.store.list('stockItem').slice(0,10);
      box.append(E.div({class:'tt'},'Recent expenses/income'));
      for(const m of money){ const c=entityCard(ctx,'money',m.id); if(c) box.append(c); }
      box.append(E.div({class:'tt', style:'margin-top:10px'},'Open debts'));
      for(const d of debts){ const c=entityCard(ctx,'debt',d.id); if(c) box.append(c); }
      box.append(E.div({class:'tt', style:'margin-top:10px'},'Inventory'));
      for(const s of stock){ const c=entityCard(ctx,'stockItem',s.id); if(c) box.append(c); }
      return box;
    }},
    { label:'Notes · Journal · Reels calendar', render: ()=>{
      const box=E.div({});
      const notes = ctx.store.list('note').slice(-8);
      const journals = ctx.store.list('journal').slice(-8);
      const drafts = ctx.store.list('instagramDraft').slice().sort((a,b)=> String((b.scheduledAt||b.createdAt)).localeCompare(String((a.scheduledAt||a.createdAt)))).slice(0,10);
      box.append(E.div({class:'tt'},'Recent notes'));
      for(const n of notes){ const c=entityCard(ctx,'note', n.id); if(c) box.append(c); }
      box.append(E.div({class:'tt', style:'margin-top:10px'},'Recent journal'));
      for(const j of journals){ const c=entityCard(ctx,'journal', j.id); if(c) box.append(c); }
      box.append(E.div({class:'tt', style:'margin-top:10px'},'Content calendar (Reels)'));
      if(!drafts.length) box.append(E.div({class:'note'},'No Reels scheduled. Prepare a video to see it here.'));
      else for(const d of drafts){
        const dt = d.scheduledAt ? new Date(d.scheduledAt).toLocaleString() : (d.publishedAt ? 'Published '+new Date(d.publishedAt).toLocaleDateString(): 'Draft');
        box.append(E.div({class:'srow'}, E.div({class:'em'}, d.status==='PUBLISHED'?'✅': d.status==='SCHEDULED'?'📅':'🎬'), E.div({class:'tx'}, E.b({}, String(d.videoName||'Reel').slice(0,40)), E.small({}, `${d.status} · ${dt}`))));
      }
      return box;
    }}
  ];

  const tabBar = E.div({ class:'choicebar', style:'margin:12px 0 8px;flex-wrap:wrap' });
  const pane = E.div({ class:'cards' });
  body.append(tabBar, pane);
  let active=0;
  function renderTab(i){
    active=i;
    [...tabBar.children].forEach((b,idx)=> b.classList.toggle('active', idx===i));
    pane.textContent='';
    pane.append(sections[i].render());
  }
  sections.forEach((s,i)=>{
    const b=E.button({class:'chip', type:'button'}, s.label);
    b.addEventListener('click', ()=> renderTab(i));
    tabBar.append(b);
  });
  renderTab(0);
  body.append(E.div({class:'hr'}));
  body.append(E.button({class:'ghost', type:'button', onclick: ()=> { if(ctx.toast) ctx.toast('Command Centre updated.'); }}, 'Refresh'));
  openSheet();
}

function openSheet(){
  const sheet=document.getElementById('sheet');
  if(sheet){ sheet.classList.add('open'); sheet.setAttribute('aria-hidden','false'); }
}

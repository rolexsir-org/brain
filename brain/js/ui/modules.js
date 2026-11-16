// Module pages — Tasks, Reminders, Notes, People, Money, Debts, Inventory,
// Habits, Journal, Events, Photos and the Instagram workspace. Every page is
// rendered from live Store records through the shared entityCard component, so
// list, search, filters, quick-add and record actions all use real data.

import { nodes as E, todayKey, formatMoney } from '../util/util.js';
import { fmtHM } from '../util/date.js';
import { entityCard } from './cards.js';
import { ACTION } from '../actions/system.js';
import { icon, iconForKind } from './icons.js';

const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const KIND_CONFIG = {
  task: {
    label: 'Tasks', newLabel: 'task', icon: 'tasks', add: true,
    filters: [['all', 'All'], ['open', 'Open'], ['done', 'Done']],
    search: record => `${record.title || ''} ${record.note || ''}`,
    sort: (a, b) => {
      if ((a.status === 'done') !== (b.status === 'done')) return a.status === 'done' ? 1 : -1;
      return String(a.due || '9999').localeCompare(String(b.due || '9999'));
    },
    empty: ['No tasks yet', 'Add your first task, or ask Brain to “add task finish the report by friday”.']
  },
  reminder: {
    label: 'Reminders', newLabel: 'reminder', icon: 'bell', add: true,
    filters: [['all', 'All'], ['active', 'Active'], ['fired', 'Waiting'], ['done', 'Done']],
    search: record => record.title || '',
    sort: (a, b) => String(a.at || a.nextAt || '9999').localeCompare(String(b.at || b.nextAt || '9999')),
  },
  note: {
    label: 'Notes', newLabel: 'note', icon: 'note', add: true,
    search: record => `${record.title || ''} ${record.body || ''}`,
    sort: (a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt))
  },
  person: {
    label: 'People', newLabel: 'person', icon: 'people', add: true,
    search: record => `${record.name || ''} ${record.phone || ''} ${record.email || ''} ${record.relationship || ''}`,
    sort: (a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt))
  },
  money: {
    label: 'Money', newLabel: 'expense', icon: 'money', add: true,
    filters: [['all', 'All'], ['expense', 'Expenses'], ['income', 'Income']],
    search: record => `${record.category || ''} ${record.kind || ''} ${record.amount || ''}`,
    sort: (a, b) => String(b.date || b.createdAt).localeCompare(String(a.date || a.createdAt))
  },
  debt: {
    label: 'Debts', newLabel: 'debt', icon: 'debt', add: true,
    filters: [['all', 'All'], ['open', 'Open'], ['settled', 'Settled']],
    search: record => `${record.person || ''} ${record.amount || ''}`,
    sort: (a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt))
  },
  stockItem: {
    label: 'Inventory', newLabel: 'stock item', icon: 'stock', add: true,
    search: record => `${record.name || ''} ${record.unit || ''}`,
    sort: (a, b) => String(a.name).localeCompare(String(b.name))
  },
  habit: {
    label: 'Habits', newLabel: 'habit', icon: 'habit', add: true,
    search: record => record.name || '',
    sort: (a, b) => String(a.name).localeCompare(String(b.name))
  },
  journal: {
    label: 'Journal', newLabel: 'entry', icon: 'journal', add: true,
    search: record => `${record.text || ''} ${record.mood || ''}`,
    sort: (a, b) => String(b.date || b.createdAt).localeCompare(String(a.date || a.createdAt))
  },
  event: {
    label: 'Events', newLabel: 'event', icon: 'calendar', add: true,
    filters: [['all', 'All'], ['upcoming', 'Upcoming'], ['today', 'Today'], ['past', 'Past']],
    search: record => `${record.title || ''} ${record.kind || ''} ${record.location || ''}`,
    sort: (a, b) => String(a.at || '9999').localeCompare(String(b.at || '9999'))
  },
  photo: {
    label: 'Photos', newLabel: 'photo', icon: 'photo', add: false,
    search: record => record.name || '',
    sort: (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)),
    empty: ['No photos yet', 'Choose a photo or take one — it stays stored on this device.']
  },
  instagramDraft: {
    label: 'Reel drafts', newLabel: 'Reel', icon: 'instagram', instagram: true,
    search: record => `${record.videoName || ''} ${record.caption || ''}`,
    sort: (a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)),
    empty: ['No Reels yet', 'Open the Instagram workspace to prepare a Reel from a video on this device.']
  },
  instagramPublication: {
    label: 'Published Reels', newLabel: 'publication', icon: 'instagram', instagram: true,
    search: record => `${record.videoName || ''} ${record.caption || ''}`,
    sort: (a, b) => String(b.publishedAt || b.createdAt).localeCompare(String(a.publishedAt || a.createdAt)),
    empty: ['Nothing published yet', 'Published Reels are recorded here after explicit approval.']
  }
};

const moduleState = new Map();

function stateFor(kind) {
  if (!moduleState.has(kind)) moduleState.set(kind, { query: '', filter: 'all' });
  return moduleState.get(kind);
}

function fieldWrap(labelText, input, note = '') {
  const wrap = E.div({ class: 'field' }, E.label({}, labelText), input);
  if (note) wrap.append(E.div({ class: 'fieldnote' }, note));
  return wrap;
}

function emptyBox(title, text, action) {
  const box = E.div({ class: 'empty' },
    E.div({ class: 'empty-icon' }, icon('inbox', { size: 22 })),
    E.div({ class: 'empty-title' }, title),
    E.div({ class: 'empty-text' }, text));
  if (action) {
    const button = E.button({ class: 'btn primary sm', type: 'button' }, action.label);
    button.addEventListener('click', action.handler);
    box.append(button);
  }
  return box;
}

function matchesFilter(record, kind, filter) {
  switch (kind) {
    case 'task': return filter === 'all' || (filter === 'open' ? record.status !== 'done' : record.status === 'done');
    case 'reminder': return filter === 'all' || String(record.status) === filter;
    case 'money': return filter === 'all' || (filter === 'income' ? record.kind === 'income' : record.kind !== 'income');
    case 'debt': return filter === 'all' || (filter === 'settled' ? record.status === 'settled' : record.status !== 'settled');
    case 'event': {
      if (filter === 'all') return true;
      if (!record.at) return filter === 'upcoming';
      const day = todayKey(new Date(record.at));
      const today = todayKey();
      if (filter === 'today') return day === today;
      if (filter === 'past') return day < today;
      return day >= today;
    }
    default: return true;
  }
}

function filteredRecords(ctx, kind) {
  const config = KIND_CONFIG[kind];
  const state = stateFor(kind);
  let records = ctx.store.list(kind);
  if (state.filter !== 'all') records = records.filter(record => matchesFilter(record, kind, state.filter));
  const query = state.query.trim().toLowerCase();
  if (query) records = records.filter(record => config.search(record).toLowerCase().includes(query));
  return records.slice().sort(config.sort);
}

function renderList(ctx, kind, container) {
  const config = KIND_CONFIG[kind];
  const records = filteredRecords(ctx, kind);
  container.textContent = '';
  if (!ctx.store.list(kind).length) {
    container.append(emptyBox(config.empty ? config.empty[0] : `No ${config.label.toLowerCase()} yet`,
      config.empty ? config.empty[1] : 'Add your first one to see it here.',
      config.add ? { label: `New ${config.newLabel}`, handler: () => openCreate(ctx, kind) } : null));
    return;
  }
  if (!records.length) {
    container.append(emptyBox('No matches', `Nothing matches “${stateFor(kind).query}”. Try a different search or filter.`));
    return;
  }
  if (kind === 'photo') {
    const grid = E.div({ class: 'photo-grid' });
    for (const record of records) {
      const card = entityCard(ctx, 'photo', record.id);
      if (card) grid.append(card);
    }
    container.append(grid);
    return;
  }
  const list = E.div({ class: 'list' });
  for (const record of records) {
    const card = entityCard(ctx, kind, record.id);
    if (card) list.append(card);
  }
  container.append(list);
}

export function renderModule(ctx, kind, container) {
  const config = KIND_CONFIG[kind];
  if (!config) return;
  const state = stateFor(kind);
  container.textContent = '';
  const pad = E.div({ class: 'view-pad' });

  if (config.instagram) {
    pad.append(instagramPanel(ctx, kind));
    const listHolder = E.div({});
    pad.append(listHolder);
    container.append(pad);
    renderList(ctx, kind, listHolder);
    return;
  }

  // Header
  const count = ctx.store.list(kind).length;
  const head = E.div({ class: 'mod-head' },
    E.div({ class: 'mod-title' },
      E.span({ class: 'mod-icon' }, icon(config.icon, { size: 20 })),
      E.h2({}, config.label),
      E.span({ class: 'count-pill' }, String(count))),
    E.div({ class: 'mod-actions' },
      E.div({ class: 'search' }, icon('search', { size: 16 }), E.input({
        type: 'search', value: state.query, placeholder: `Search ${config.label.toLowerCase()}…`,
        'aria-label': `Search ${config.label}`, enterkeyhint: 'search'
      })),
      config.add
        ? E.button({ class: 'btn primary sm', type: 'button' }, icon('plus', { size: 15 }), `New ${config.newLabel}`)
        : E.button({ class: 'btn primary sm', type: 'button' }, icon('camera', { size: 15 }), 'Add photo')));
  pad.append(head);

  if (kind === 'photo') {
    const pickButton = head.querySelector('.btn');
    pickButton.addEventListener('click', () => ctx.runAction({ id: ACTION.PHOTO_PICK, args: {} }));
  } else if (config.add) {
    head.querySelector('.btn').addEventListener('click', () => openCreate(ctx, kind));
  }

  const searchInput = head.querySelector('input[type="search"]');
  searchInput.addEventListener('input', () => {
    state.query = searchInput.value;
    renderList(ctx, kind, listHolder);
  });

  // Filters
  let filterBar = null;
  if (config.filters) {
    filterBar = E.div({ class: 'filters' });
    for (const [value, label] of config.filters) {
      const chip = E.button({ class: `chip filter-chip${state.filter === value ? ' active' : ''}`, type: 'button', 'aria-pressed': state.filter === value ? 'true' : 'false' }, label);
      chip.addEventListener('click', () => {
        state.filter = value;
        [...filterBar.children].forEach((node, index) => {
          const active = config.filters[index][0] === value;
          node.classList.toggle('active', active);
          node.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
        renderList(ctx, kind, listHolder);
      });
      filterBar.append(chip);
    }
    pad.append(filterBar);
  }

  const listHolder = E.div({});
  pad.append(listHolder);
  renderList(ctx, kind, listHolder);
  container.append(pad);
}

function instagramPanel(ctx, kind) {
  const connected = !!ctx.store.settings.instagram?.connected;
  const banner = E.div({ class: 'card mod-banner' },
    E.div({ class: 'mod-banner-icon' }, icon('instagram', { size: 22 })),
    E.div({ class: 'mod-banner-body' },
      E.b({}, connected ? `Instagram connected${ctx.store.settings.instagram.username ? ` as @${ctx.store.settings.instagram.username}` : ''}` : 'Instagram not connected'),
      E.small({}, connected ? 'Prepare Reels, schedule publishing, and review drafts here.' : 'Connect a Business account to prepare and publish Reels.')),
    E.button({ class: 'btn ghost sm', type: 'button' }, icon('arrowRight', { size: 15 }), 'Open workspace'));
  banner.querySelector('.btn').addEventListener('click', () => ctx.runAction({ id: ACTION.INSTAGRAM_OPEN, args: { id: 'hub' } }));
  return banner;
}

/* ---------------- Quick add ---------------- */

export function openCreate(ctx, kind) {
  if (kind === 'photo') { ctx.runAction({ id: ACTION.PHOTO_PICK, args: {} }); return; }
  if (kind === 'instagramDraft' || kind === 'instagramPublication') {
    ctx.runAction({ id: ACTION.INSTAGRAM_OPEN, args: { id: 'hub' } });
    return;
  }
  const config = KIND_CONFIG[kind];
  const body = document.getElementById('sheetBody');
  const titleEl = document.getElementById('sheetTitle');
  if (!body || !titleEl) return;
  titleEl.textContent = `New ${config.newLabel}`;
  body.textContent = '';

  const inputs = {};
  const addField = (name, labelText, input, note) => {
    inputs[name] = input;
    body.append(fieldWrap(labelText, input, note));
  };

  if (kind === 'task') {
    addField('title', 'Task', E.input({ type: 'text', placeholder: 'What needs doing?' }));
    addField('due', 'Due', E.input({ type: 'datetime-local' }));
    addField('note', 'Note', E.textarea({ placeholder: 'Optional details' }));
  } else if (kind === 'reminder') {
    addField('title', 'Reminder', E.input({ type: 'text', placeholder: 'What should Brain remind you about?' }));
    addField('at', 'Date and time', E.input({ type: 'datetime-local' }));
  } else if (kind === 'note') {
    addField('title', 'Title', E.input({ type: 'text' }));
    addField('body', 'Note', E.textarea({ placeholder: 'Write it down…' }));
  } else if (kind === 'person') {
    addField('name', 'Name', E.input({ type: 'text', placeholder: 'e.g. Priya' }));
    addField('phone', 'Phone', E.input({ type: 'tel', placeholder: 'Optional' }));
    addField('email', 'Email', E.input({ type: 'email', placeholder: 'Optional' }));
  } else if (kind === 'money') {
    const kindSelect = E.select({}, E.option({ value: 'expense' }, 'Expense'), E.option({ value: 'income' }, 'Income'));
    addField('kind', 'Type', kindSelect);
    addField('category', 'Category', E.input({ type: 'text', placeholder: 'e.g. Groceries' }));
    addField('amount', 'Amount', E.input({ type: 'number', min: '0', step: '0.01', inputmode: 'decimal' }));
    addField('date', 'Date', E.input({ type: 'datetime-local' }));
  } else if (kind === 'debt') {
    addField('person', 'Person', E.input({ type: 'text', placeholder: 'Who is this with?' }));
    const dir = E.select({}, E.option({ value: 'i_owe_them' }, 'I owe them'), E.option({ value: 'they_owe_me' }, 'They owe me'));
    addField('dir', 'Direction', dir);
    addField('amount', 'Amount', E.input({ type: 'number', min: '0', step: '0.01', inputmode: 'decimal' }));
  } else if (kind === 'stockItem') {
    addField('name', 'Item', E.input({ type: 'text', placeholder: 'e.g. Rice' }));
    addField('qty', 'Quantity', E.input({ type: 'number', min: '0', step: '1', inputmode: 'decimal' }));
    addField('unit', 'Unit', E.input({ type: 'text', placeholder: 'kg, litres, packs…' }));
    addField('lowThreshold', 'Low-stock alert at', E.input({ type: 'number', min: '0', step: '1', inputmode: 'decimal' }));
  } else if (kind === 'habit') {
    addField('name', 'Habit', E.input({ type: 'text', placeholder: 'e.g. Read 20 minutes' }));
  } else if (kind === 'journal') {
    addField('text', 'Entry', E.textarea({ placeholder: 'How was your day?' }));
    addField('mood', 'Mood', E.select({}, E.option({ value: '' }, 'No mood'), E.option({ value: 'happy' }, 'Happy'), E.option({ value: 'down' }, 'Down'), E.option({ value: 'tired' }, 'Tired'), E.option({ value: 'stressed' }, 'Stressed')));
    addField('date', 'Date', E.input({ type: 'datetime-local' }));
  } else if (kind === 'event') {
    addField('title', 'Event', E.input({ type: 'text', placeholder: 'e.g. Dentist appointment' }));
    addField('at', 'Start', E.input({ type: 'datetime-local' }));
    addField('end', 'End', E.input({ type: 'datetime-local' }));
    addField('location', 'Location', E.textarea({ placeholder: 'Optional' }));
  }

  const save = E.button({ class: 'primary', type: 'button' }, 'Save');
  save.addEventListener('click', async () => {
    const payload = {};
    if (kind === 'task') {
      payload.title = inputs.title.value.trim();
      if (!payload.title) { ctx.toast('Give the task a title.'); return; }
      payload.note = inputs.note.value.trim();
      payload.due = inputs.due.value ? new Date(inputs.due.value).toISOString() : null;
      payload.status = 'open';
    } else if (kind === 'reminder') {
      payload.title = inputs.title.value.trim();
      if (!payload.title) { ctx.toast('Give the reminder a title.'); return; }
      const at = inputs.at.value ? new Date(inputs.at.value) : null;
      if (!at || Number.isNaN(at.getTime())) { ctx.toast('Choose a date and time.'); return; }
      payload.at = at.toISOString();
      payload.status = 'active';
    } else if (kind === 'note') {
      payload.title = inputs.title.value.trim() || 'Note';
      payload.body = inputs.body.value.trim();
    } else if (kind === 'person') {
      payload.name = inputs.name.value.trim();
      payload.phone = inputs.phone.value.trim();
      payload.email = inputs.email.value.trim();
      if (!payload.name && !payload.phone && !payload.email) { ctx.toast('Add a name, phone or email.'); return; }
    } else if (kind === 'money') {
      payload.kind = inputs.kind.value;
      payload.category = inputs.category.value.trim() || inputs.kind.value;
      payload.amount = inputs.amount.value === '' ? null : Number(inputs.amount.value);
      if (payload.amount == null || !Number.isFinite(payload.amount) || payload.amount < 0) { ctx.toast('Enter a valid amount.'); return; }
      payload.date = inputs.date.value ? new Date(inputs.date.value).toISOString() : new Date().toISOString();
    } else if (kind === 'debt') {
      payload.person = inputs.person.value.trim() || 'Person';
      payload.dir = inputs.dir.value;
      payload.amount = inputs.amount.value === '' ? null : Number(inputs.amount.value);
      if (payload.amount == null || !Number.isFinite(payload.amount) || payload.amount < 0) { ctx.toast('Enter a valid amount.'); return; }
      payload.status = 'open';
    } else if (kind === 'stockItem') {
      payload.name = inputs.name.value.trim();
      if (!payload.name) { ctx.toast('Name the item.'); return; }
      payload.qty = inputs.qty.value === '' ? 0 : Number(inputs.qty.value);
      payload.unit = inputs.unit.value.trim();
      payload.lowThreshold = inputs.lowThreshold.value === '' ? null : Number(inputs.lowThreshold.value);
      if (!Number.isFinite(payload.qty) || payload.qty < 0) { ctx.toast('Enter a valid quantity.'); return; }
      if (payload.lowThreshold != null && (!Number.isFinite(payload.lowThreshold) || payload.lowThreshold < 0)) { ctx.toast('Enter a valid low-stock threshold.'); return; }
    } else if (kind === 'habit') {
      payload.name = inputs.name.value.trim();
      if (!payload.name) { ctx.toast('Name the habit.'); return; }
      payload.log = [];
    } else if (kind === 'journal') {
      payload.text = inputs.text.value.trim();
      payload.mood = inputs.mood.value;
      payload.date = inputs.date.value ? new Date(inputs.date.value).toISOString() : new Date().toISOString();
    } else if (kind === 'event') {
      payload.title = inputs.title.value.trim();
      if (!payload.title) { ctx.toast('Give the event a title.'); return; }
      payload.at = inputs.at.value ? new Date(inputs.at.value).toISOString() : null;
      payload.end = inputs.end.value ? new Date(inputs.end.value).toISOString() : null;
      payload.location = inputs.location.value.trim();
      payload.allDay = false;
      if (payload.at && payload.end && new Date(payload.end) < new Date(payload.at)) { ctx.toast('End time cannot be before the start time.'); return; }
    }

    const record = ctx.store.addSync(kind, payload);
    if (!record) { ctx.toast('Could not save that. Device storage may be full.'); return; }
    const flushed = await ctx.store.flush();
    if (!flushed.ok) { ctx.toast('Could not save that. Check device storage and try again.'); return; }
    closePanel();
    if (ctx.afterMutate) ctx.afterMutate();
    ctx.toast('Saved.');
  });

  body.append(save, E.button({ class: 'ghost', type: 'button', onclick: () => closePanel() }, 'Cancel'));
  openPanel();
}

function openPanel() {
  // Let the app shell own the sheet: it adds the class, traps focus, hides the
  // background and pushes the history entry exactly once.
  try { document.dispatchEvent(new CustomEvent('brain:sheet-open')); } catch {}
}
function closePanel() {
  try { document.dispatchEvent(new CustomEvent('brain:sheet-close')); } catch {}
}

/* ---------------- Calendar ---------------- */

const calCursor = { year: null, month: null, selected: null };
const agendaCardRef = { card: null };

export function renderCalendar(ctx, container) {
  const now = new Date();
  if (calCursor.year == null) {
    calCursor.year = now.getFullYear();
    calCursor.month = now.getMonth();
    calCursor.selected = todayKey(now);
  }
  container.textContent = '';
  const pad = E.div({ class: 'view-pad' });
  const head = E.div({ class: 'mod-head' },
    E.div({ class: 'mod-title' },
      E.span({ class: 'mod-icon' }, icon('calendar', { size: 20 })),
      E.h2({}, 'Calendar'),
      E.span({ class: 'count-pill' }, `${ctx.store.list('event').length} events`)),
    E.div({ class: 'mod-actions' }, E.button({ class: 'btn primary sm', type: 'button' }, icon('plus', { size: 15 }), 'New event')));
  head.querySelector('.btn').addEventListener('click', () => openCreate(ctx, 'event'));
  pad.append(head);

  const wrap = E.div({ class: 'cal-wrap' });
  const gridCard = E.div({ class: 'card cal-card' });
  const agendaCard = E.div({ class: 'card cal-card' });
  agendaCardRef.card = agendaCard;
  wrap.append(gridCard, agendaCard);
  pad.append(wrap);

  renderMonthGrid(ctx, gridCard, agendaCard);
  renderDayAgenda(ctx, agendaCard, calCursor.selected);

  // Upcoming agenda, next 14 days.
  const upcoming = E.section({ class: 'card panel' }, E.div({ class: 'panel-head' },
    E.span({ class: 'panel-icon' }, icon('clock', { size: 16 })),
    E.h3({}, 'Next 14 days')));
  const groups = upcomingByDay(ctx, 14);
  if (!groups.length) {
    upcoming.append(emptyBox('Nothing scheduled', 'Events and dated tasks will appear here. Ask Brain to schedule something.'));
  } else {
    for (const group of groups) upcoming.append(agendaDay(ctx, group));
  }
  pad.append(upcoming);
  container.append(pad);
}

function eventsOn(ctx, dayKey) {
  const events = ctx.store.list('event').filter(event => event.at && todayKey(new Date(event.at)) === dayKey);
  const tasks = ctx.store.list('task').filter(task => task.due && task.status !== 'done' && todayKey(new Date(task.due)) === dayKey);
  return { events, tasks };
}

function renderMonthGrid(ctx, card, agendaCard = agendaCardRef.card) {
  agendaCardRef.card = agendaCard;
  card.textContent = '';
  const { year, month } = calCursor;
  const header = E.div({ class: 'cal-head' },
    E.h3({}, `${MONTHS[month]} ${year}`),
    E.div({ class: 'cal-nav' },
      E.button({ class: 'iconbtn', type: 'button', 'aria-label': 'Previous month' }, icon('chevronLeft', { size: 17 })),
      E.button({ class: 'iconbtn', type: 'button', 'aria-label': 'Next month' }, icon('chevronRight', { size: 17 }))));
  const [prev, next] = header.querySelectorAll('.iconbtn');
  prev.addEventListener('click', () => { shiftMonth(-1); renderMonthGrid(ctx, card, agendaCardRef.card); });
  next.addEventListener('click', () => { shiftMonth(1); renderMonthGrid(ctx, card, agendaCardRef.card); });
  card.append(header);

  const grid = E.div({ class: 'cal-grid', role: 'grid', 'aria-label': `${MONTHS[month]} ${year}` });
  for (const dow of DAYS_SHORT) grid.append(E.div({ class: 'cal-dow' }, dow));
  const first = new Date(year, month, 1);
  const startPad = first.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const prevDays = new Date(year, month, 0).getDate();
  const today = todayKey();
  for (let i = 0; i < 42; i += 1) {
    const dayNum = i - startPad + 1;
    let cellYear = year, cellMonth = month, label = dayNum, other = false;
    if (dayNum < 1) { label = prevDays + dayNum; other = true; }
    else if (dayNum > daysInMonth) { label = dayNum - daysInMonth; other = true; }
    const key = todayKey(new Date(year, month, dayNum));
    const { events, tasks } = eventsOn(ctx, key);
    const classes = ['cal-day'];
    if (other) classes.push('other');
    if (key === today) classes.push('today');
    if (key === calCursor.selected) classes.push('selected');
    const cell = E.button({ class: classes.join(' '), type: 'button', 'aria-label': `${key}, ${events.length} events, ${tasks.length} tasks` },
      E.span({}, String(label)),
      E.span({ class: 'cal-dots' },
        events.slice(0, 3).map(() => E.i({ class: 'cal-dot-event' })),
        tasks.slice(0, 3).map(() => E.i({ class: 'cal-dot-task' }))));
    cell.addEventListener('click', () => {
      calCursor.selected = key;
      renderMonthGrid(ctx, card, agendaCard);
      renderDayAgenda(ctx, agendaCard, key);
    });
    grid.append(cell);
  }
  card.append(grid);
  card.append(E.div({ class: 'cal-legend' },
    E.span({}, E.i({ class: 'cal-dot-event' }), ' Events'),
    E.span({}, E.i({ class: 'cal-dot-task' }), ' Tasks')));
}

function shiftMonth(delta) {
  let month = calCursor.month + delta;
  let year = calCursor.year;
  if (month < 0) { month = 11; year -= 1; }
  if (month > 11) { month = 0; year += 1; }
  calCursor.month = month;
  calCursor.year = year;
}

function renderDayAgenda(ctx, card, dayKey) {
  if (!card) return;
  card.textContent = '';
  const date = new Date(dayKey + 'T00:00:00');
  const isToday = dayKey === todayKey();
  card.append(E.div({ class: 'cal-head' }, E.h3({}, isToday ? 'Today' : date.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }))));
  const { events, tasks } = eventsOn(ctx, dayKey);
  if (!events.length && !tasks.length) {
    card.append(emptyBox('Nothing on this day', 'Select another day, or ask Brain to add an event or task.'));
    return;
  }
  const box = E.div({});
  const items = [
    ...tasks.map(task => ({ kind: 'task', record: task, at: task.due })),
    ...events.map(event => ({ kind: 'event', record: event, at: event.at }))
  ].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  for (const item of items) {
    const time = item.record.allDay ? 'All day' : fmtHM(new Date(item.at).getHours(), new Date(item.at).getMinutes());
    const row = E.div({ class: 'agenda-item' },
      E.span({ class: 'agenda-time' }, time),
      E.span({ class: 'agenda-icon' }, icon(item.kind === 'task' ? 'tasks' : 'calendar', { size: 14 })),
      E.span({ class: 'agenda-body' },
        E.b({}, item.record.title || 'Untitled'),
        E.small({}, item.kind === 'task' ? 'Task' : item.record.kind || 'Event')));
    box.append(row);
  }
  card.append(box);
}

function upcomingByDay(ctx, days) {
  const groups = [];
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  for (let offset = 0; offset < days; offset += 1) {
    const day = new Date(base);
    day.setDate(day.getDate() + offset);
    const key = todayKey(day);
    const { events, tasks } = eventsOn(ctx, key);
    if (events.length || tasks.length) groups.push({ key, day, events, tasks });
  }
  return groups;
}

function agendaDay(ctx, group) {
  const box = E.div({ class: 'agenda-day' });
  const isToday = group.key === todayKey();
  box.append(E.div({ class: 'agenda-day-head' },
    E.b({}, isToday ? 'Today' : group.day.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })),
    E.span({}, `${group.events.length + group.tasks.length} item${group.events.length + group.tasks.length === 1 ? '' : 's'}`)));
  const items = [
    ...group.tasks.map(task => ({ kind: 'task', record: task, at: task.due })),
    ...group.events.map(event => ({ kind: 'event', record: event, at: event.at }))
  ].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  for (const item of items) {
    const time = item.record.allDay ? 'All day' : fmtHM(new Date(item.at).getHours(), new Date(item.at).getMinutes());
    const row = E.div({ class: 'agenda-item' },
      E.span({ class: 'agenda-time' }, time),
      E.span({ class: 'agenda-icon' }, icon(item.kind === 'task' ? 'tasks' : 'calendar', { size: 14 })),
      E.span({ class: 'agenda-body' },
        E.b({}, item.record.title || 'Untitled'),
        E.small({}, item.kind === 'task' ? 'Task' : item.record.kind || 'Event')));
    box.append(row);
  }
  return box;
}

/* ---------------- More ---------------- */

export function renderMore(ctx, container) {
  container.textContent = '';
  const pad = E.div({ class: 'view-pad' });
  pad.append(E.div({ class: 'mod-head' },
    E.div({ class: 'mod-title' },
      E.span({ class: 'mod-icon' }, icon('more', { size: 20 })),
      E.h2({}, 'More'),
      E.span({ class: 'count-pill' }, 'All modules'))));

  const grid = E.div({ class: 'tile-grid' });
  const modules = [
    ['task', 'Tasks'], ['reminder', 'Reminders'], ['note', 'Notes'], ['person', 'People'],
    ['money', 'Money'], ['debt', 'Debts'], ['stockItem', 'Inventory'], ['habit', 'Habits'],
    ['journal', 'Journal'], ['event', 'Events'], ['photo', 'Photos'],
    ['instagramDraft', 'Reels'], ['instagramPublication', 'Published']
  ];
  for (const [kind, label] of modules) {
    const count = ctx.store.list(kind).length;
    const tile = E.button({ class: 'tile', type: 'button' },
      E.span({ class: 'tile-icon' }, icon(iconForKind(kind), { size: 19 })),
      E.span({ class: 'tile-name' }, label),
      E.span({ class: 'tile-meta' }, kind === 'instagramDraft' || kind === 'instagramPublication'
        ? (ctx.store.settings.instagram?.connected ? 'Workspace' : 'Not connected')
        : 'Stored on this device'),
      E.span({ class: 'tile-count' }, `${count} record${count === 1 ? '' : 's'}`));
    tile.addEventListener('click', () => {
      if (kind === 'instagramDraft') ctx.runAction({ id: ACTION.INSTAGRAM_OPEN, args: { id: 'hub' } });
      else ctx.go('module', { kind });
    });
    grid.append(tile);
  }

  pad.append(E.div({ class: 'section-title' }, 'Modules'), grid);

  const tools = [
    { icon: 'assistant', name: 'Command Centre', meta: 'Search everything', handler: () => ctx.runAction({ id: ACTION.COMMAND_CENTRE_OPEN, args: {} }) },
    { icon: 'zap', name: 'Automation Centre', meta: 'Permissions & automations', handler: () => ctx.runAction({ id: ACTION.AUTOMATION_CENTRE_OPEN, args: {} }) },
    { icon: 'settings', name: 'Settings', meta: 'Name, currency, notifications', handler: () => ctx.openSettings && ctx.openSettings() },
    { icon: 'database', name: 'Back up', meta: 'Save or restore a backup', handler: () => ctx.doExport && ctx.doExport() },
    { icon: 'shield', name: 'Device capabilities', meta: 'What this browser can do', handler: () => ctx.openDiagnostics && ctx.openDiagnostics() },
    { icon: 'activity', name: 'Diagnostics & release', meta: 'Storage, integrity, version', handler: () => ctx.openDiagnosticsPanel && ctx.openDiagnosticsPanel() }
  ];
  const toolGrid = E.div({ class: 'tile-grid' });
  for (const tool of tools) {
    const tile = E.button({ class: 'tile', type: 'button' },
      E.span({ class: 'tile-icon' }, icon(tool.icon, { size: 19 })),
      E.span({ class: 'tile-name' }, tool.name),
      E.span({ class: 'tile-meta' }, tool.meta));
    tile.addEventListener('click', tool.handler);
    toolGrid.append(tile);
  }
  pad.append(E.div({ class: 'section-title' }, 'Tools & privacy'), toolGrid);
  container.append(pad);
}

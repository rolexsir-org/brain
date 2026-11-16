// Home / Command Centre — a real-data overview built only from the Store.
// No demonstration metrics: every number and row is derived from records the
// user actually created, and empty states replace invented content.

import { nodes as E, todayKey, formatMoney } from '../util/util.js';
import { fmtHM } from '../util/date.js';
import { ACTION } from '../actions/system.js';
import { icon, iconForKind } from './icons.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function greeting() {
  const hour = new Date().getHours();
  return hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
}

function dateLine() {
  const now = new Date();
  return `${DAYS[now.getDay()]}, ${MONTHS[now.getMonth()]} ${now.getDate()}`;
}

function isToday(iso) {
  if (!iso) return false;
  const date = new Date(iso);
  return !Number.isNaN(date.getTime()) && todayKey(date) === todayKey();
}

function isOverdue(iso) {
  if (!iso) return false;
  const date = new Date(iso);
  return !Number.isNaN(date.getTime()) && todayKey(date) < todayKey();
}

function timeLabel(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return fmtHM(date.getHours(), date.getMinutes());
}

function relative(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function titleOf(kind, record) {
  return record.title || record.name || record.person || record.videoName || record.text || 'Untitled';
}

function emptyState(iconName, title, text, action) {
  const box = E.div({ class: 'empty' },
    E.div({ class: 'empty-icon' }, icon(iconName, { size: 22 })),
    E.div({ class: 'empty-title' }, title),
    E.div({ class: 'empty-text' }, text));
  if (action) {
    const button = E.button({ class: 'btn primary sm', type: 'button' }, action.label);
    button.addEventListener('click', action.handler);
    box.append(button);
  }
  return box;
}

function panel(iconName, title, linkLabel, linkHandler) {
  const head = E.div({ class: 'panel-head' },
    E.span({ class: 'panel-icon' }, icon(iconName, { size: 16 })),
    E.h3({}, title));
  if (linkLabel) {
    const link = E.button({ class: 'panel-link', type: 'button' }, linkLabel);
    link.addEventListener('click', linkHandler);
    head.append(link);
  }
  return E.section({ class: 'card panel' }, head);
}

export function renderHome(ctx, container) {
  const store = ctx.store;
  const now = new Date();
  const today = todayKey(now);
  const name = store.settings.name;

  container.textContent = '';
  const pad = E.div({ class: 'view-pad dash' });

  // ---- Hero ----
  const hero = E.section({ class: 'hero' },
    E.div({ class: 'hero-icon' }, icon('brain', { size: 26, strokeWidth: 1.8 })),
    E.div({ class: 'hero-body' },
      E.div({ class: 'eyebrow' }, dateLine()),
      E.h2({}, `${greeting()}${name ? `, ${name}` : ''}`),
      E.div({ class: 'hero-sub' }, 'Here is what is on your mind today — privately, on this device.')),
    E.button({ class: 'brain-cta', type: 'button' }, icon('assistant', { size: 18 }), 'Ask Brain'));
  hero.querySelector('.brain-cta').addEventListener('click', () => {
    if (ctx.go) ctx.go('assistant');
    setTimeout(() => { const input = document.querySelector('#in'); if (input) input.focus(); }, 30);
  });
  if (!name) {
    pad.append(E.div({ class: 'banner' }, 'Welcome to Brain. Open the Assistant and tell me your name — everything you add stays private on this device.'));
  }
  pad.append(hero);

  // ---- Derived stats ----
  const openTasks = store.list('task').filter(task => task.status !== 'done');
  const dueTodayTasks = openTasks.filter(task => task.due && isToday(task.due));
  const overdueTasks = openTasks.filter(task => task.due && isOverdue(task.due));
  const activeReminders = store.list('reminder').filter(reminder => reminder.status === 'active');
  const habits = store.list('habit');
  const habitsLoggedToday = habits.filter(habit => (habit.log || []).includes(today)).length;

  const month = now.getMonth();
  const year = now.getFullYear();
  const moneyThisMonth = store.list('money').filter(record => {
    const date = record.date ? new Date(record.date) : null;
    return date && !Number.isNaN(date.getTime()) && date.getMonth() === month && date.getFullYear() === year;
  });
  const spent = moneyThisMonth.filter(record => record.kind !== 'income').reduce((sum, record) => sum + (Number(record.amount) || 0), 0);
  const earned = moneyThisMonth.filter(record => record.kind === 'income').reduce((sum, record) => sum + (Number(record.amount) || 0), 0);

  const stats = [
    { icon: 'tasks', value: String(dueTodayTasks.length + overdueTasks.length), label: 'Tasks due', foot: overdueTasks.length ? `${overdueTasks.length} overdue` : 'on track', view: () => ctx.go('module', { kind: 'task' }) },
    { icon: 'bell', value: String(activeReminders.length), label: 'Reminders', foot: 'active', view: () => ctx.go('module', { kind: 'reminder' }) },
    { icon: 'habit', value: `${habitsLoggedToday}/${habits.length}`, label: 'Habits today', foot: habits.length ? 'logged' : 'no habits yet', view: () => ctx.go('module', { kind: 'habit' }) },
    { icon: 'money', value: formatMoney(spent, ctx.cur || {}), label: 'Spent this month', foot: `${formatMoney(earned, ctx.cur || {})} in`, view: () => ctx.go('module', { kind: 'money' }) }
  ];
  const statGrid = E.div({ class: 'stat-grid' });
  for (const stat of stats) {
    const card = E.button({ class: 'card stat', type: 'button' },
      E.span({ class: 'stat-icon' }, icon(stat.icon, { size: 17 })),
      E.span({ class: 'stat-value' }, stat.value),
      E.span({ class: 'stat-label' }, stat.label),
      E.span({ class: 'stat-foot' }, stat.foot));
    card.addEventListener('click', stat.view);
    statGrid.append(card);
  }
  pad.append(statGrid);

  // ---- Daily brief (only on days with something worth saying) ----
  const briefText = typeof ctx.getBrief === 'function' ? ctx.getBrief() : null;
  if (briefText) {
    const briefPanel = panel('sparkles', 'Daily brief', null, null);
    briefPanel.append(E.div({ class: 'brief-text' }, briefText));
    pad.append(briefPanel);
  }

  // ---- Focus: tasks due ----
  const focusPanel = panel('tasks', 'Today’s focus', 'All tasks', () => ctx.go('module', { kind: 'task' }));
  const focusList = E.div({});
  const focusTasks = [...dueTodayTasks, ...overdueTasks]
    .sort((a, b) => new Date(a.due) - new Date(b.due))
    .slice(0, 5);
  if (!focusTasks.length) {
    focusList.append(emptyState('check', 'Nothing due today',
      openTasks.length ? 'You have open tasks without a due date. Enjoy the clear runway.' : 'No open tasks. Add one with your voice or the New button.',
      { label: 'Add a task', handler: () => ctx.go('assistant') }));
  } else {
    for (const task of focusTasks) {
      const overdue = isOverdue(task.due);
      const row = E.div({ class: 'rowline', role: 'button', tabindex: '0' },
        E.span({ class: 'rl-icon' }, icon('tasks', { size: 15 })),
        E.span({ class: 'rl-body' },
          E.span({ class: 'rl-title' }, task.title || 'Untitled task'),
          E.span({ class: 'rl-sub' }, `${overdue ? 'Overdue · ' : 'Today · '}${timeLabel(task.due)}`)),
        E.button({ class: `mini ${overdue ? 'r' : 'g'}`, type: 'button', 'aria-label': `Mark ${task.title || 'task'} done` }, overdue ? 'Clear' : 'Done'));
      const done = row.querySelector('.mini');
      done.addEventListener('click', async () => { await ctx.runAction({ id: ACTION.TASK_COMPLETE, args: { kind: 'task', id: task.id } }); });
      const open = () => ctx.go('module', { kind: 'task' });
      row.addEventListener('click', open);
      row.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
      focusList.append(row);
    }
  }
  focusPanel.append(focusList);

  const grid = E.div({ class: 'dash-grid' });
  grid.append(focusPanel);
  pad.append(grid);

  // Reminders panel
  const reminderPanel = panel('bell', 'Upcoming reminders', 'All reminders', () => ctx.go('module', { kind: 'reminder' }));
  const reminderList = E.div({});
  const upcoming = activeReminders
    .map(reminder => ({ reminder, at: reminder.at || reminder.nextAt || (reminder.recur ? reminder.recur.time : '') }))
    .filter(item => item.at)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))
    .slice(0, 5);
  if (!upcoming.length) {
    reminderList.append(emptyState('bell', 'No upcoming reminders', 'Ask Brain to remind you about anything at a time that suits you.'));
  } else {
    for (const { reminder, at } of upcoming) {
      const isTime = typeof at === 'string' && /^\d{2}:\d{2}$/.test(at);
      const when = isTime ? `today · ${at}` : `${new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${timeLabel(at)}`;
      const row = E.div({ class: 'rowline' },
        E.span({ class: 'rl-icon' }, icon('bell', { size: 15 })),
        E.span({ class: 'rl-body' },
          E.span({ class: 'rl-title' }, reminder.title || 'Reminder'),
          E.span({ class: 'rl-sub' }, when)),
        E.span({ class: 'rl-right' }, reminder.recur ? E.span({ class: 'badge' }, 'Repeats') : null));
      reminderList.append(row);
    }
  }
  reminderPanel.append(reminderList);
  grid.append(reminderPanel);
  pad.append(grid);

  // Habits + activity in a second grid row
  const grid2 = E.div({ class: 'dash-grid' });
  const habitPanel = panel('habit', 'Habit progress', 'All habits', () => ctx.go('module', { kind: 'habit' }));
  const habitList = E.div({});
  if (!habits.length) {
    habitList.append(emptyState('habit', 'No habits yet', 'Create a habit in Brain and log it daily to build a streak.'));
  } else {
    for (const habit of habits.slice(0, 6)) {
      const logged = (habit.log || []).includes(today);
      const row = E.div({ class: 'habit-row' },
        E.span({ class: 'habit-name' }, habit.name || 'Habit'),
        E.span({ class: 'habit-streak' }, `${streakOf(habit.log)} day streak`),
        E.button({ class: `mini ${logged ? 'g' : ''}`, type: 'button', 'aria-label': logged ? `${habit.name} logged today` : `Log ${habit.name} for today` }, logged ? 'Logged' : 'Log'));
      row.querySelector('.mini').addEventListener('click', async () => {
        if (logged) { ctx.toast('Already logged today.'); return; }
        await ctx.runAction({ id: ACTION.HABIT_LOG, args: { kind: 'habit', id: habit.id } });
      });
      habitList.append(row);
    }
  }
  habitPanel.append(habitList);
  grid2.append(habitPanel);

  const activityPanel = panel('clock', 'Recent activity', 'Command Centre', () => ctx.runAction({ id: ACTION.COMMAND_CENTRE_OPEN, args: {} }));
  const activityList = E.div({});
  const recent = [];
  for (const kind of ['task', 'reminder', 'note', 'person', 'money', 'debt', 'stockItem', 'habit', 'journal', 'event', 'photo', 'instagramDraft', 'instagramPublication']) {
    for (const record of store.list(kind)) {
      recent.push({ kind, record, at: record.updatedAt || record.createdAt || '' });
    }
  }
  recent.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const top = recent.slice(0, 8);
  if (!top.length) {
    activityList.append(emptyState('sparkles', 'A fresh start', 'Everything you add will appear here. Try asking Brain to add a task or a note.'));
  } else {
    for (const item of top) {
      const row = E.button({ class: 'rowline', type: 'button' },
        E.span({ class: 'rl-icon' }, icon(iconForKind(item.kind), { size: 15 })),
        E.span({ class: 'rl-body' },
          E.span({ class: 'rl-title' }, titleOf(item.kind, item.record)),
          E.span({ class: 'rl-sub' }, `${labelOf(item.kind)} · ${relative(item.at)}`)));
      row.addEventListener('click', () => ctx.go('module', { kind: item.kind }));
      activityList.append(row);
    }
  }
  activityPanel.append(activityList);
  grid2.append(activityPanel);
  pad.append(grid2);

  // ---- Quick actions ----
  const quickPanel = E.section({ class: 'card panel' }, E.div({ class: 'panel-head' },
    E.span({ class: 'panel-icon' }, icon('zap', { size: 16 })),
    E.h3({}, 'Quick actions')));
  const qa = E.div({ class: 'qa-grid' });
  const actions = [
    { icon: 'tasks', label: 'New task', handler: () => ctx.go('assistant', { prompt: 'add task ' }) },
    { icon: 'bell', label: 'New reminder', handler: () => ctx.go('assistant', { prompt: 'remind me to ' }) },
    { icon: 'note', label: 'New note', handler: () => ctx.go('assistant', { prompt: 'remember ' }) },
    { icon: 'money', label: 'Add expense', handler: () => ctx.go('assistant', { prompt: 'spent ' }) },
    { icon: 'camera', label: 'Add photo', handler: () => ctx.runAction({ id: ACTION.PHOTO_PICK, args: {} }) },
    { icon: 'calendar', label: 'New event', handler: () => ctx.go('assistant', { prompt: 'schedule ' }) },
    { icon: 'journal', label: 'Journal', handler: () => ctx.go('module', { kind: 'journal' }) },
    { icon: 'assistant', label: 'Ask Brain', handler: () => ctx.go('assistant') }
  ];
  for (const action of actions) {
    const button = E.button({ class: 'qa', type: 'button' },
      E.span({ class: 'qa-icon' }, icon(action.icon, { size: 16 })),
      action.label);
    button.addEventListener('click', action.handler);
    qa.append(button);
  }
  quickPanel.append(qa);
  pad.append(quickPanel);

  container.append(pad);
}

function streakOf(log) {
  const set = new Set(log || []);
  const day = new Date();
  let count = 0;
  while (set.has(todayKey(day))) { count += 1; day.setDate(day.getDate() - 1); }
  return count;
}

function labelOf(kind) {
  const labels = {
    task: 'Task', reminder: 'Reminder', note: 'Note', person: 'Person', money: 'Money',
    debt: 'Debt', stockItem: 'Stock', habit: 'Habit', journal: 'Journal', event: 'Event',
    photo: 'Photo', instagramDraft: 'Reel draft', instagramPublication: 'Published Reel'
  };
  return labels[kind] || kind;
}

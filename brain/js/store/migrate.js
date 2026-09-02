// Migration from the earlier single-file Brain format (localStorage
// 'brain.state.v1') into the current schema. Pure function so it is testable.

export function migrateLegacy(old) {
  if (!old || typeof old !== 'object') return null;
  const c = { task: [], reminder: [], note: [], person: [], money: [], debt: [], stockItem: [], habit: [], journal: [], event: [] };
  const nowIso = () => new Date().toISOString();
  const iso = v => { if (!v) return null; const d = new Date(v); return isNaN(d.getTime()) ? null : d.toISOString(); };

  for (const t of old.tasks || []) {
    c.task.push({ title: t.title || '', note: t.note || '', due: iso(t.due), status: t.done ? 'done' : 'open', completedAt: iso(t.completedDate), priority: 1 });
  }
  for (const r of old.reminders || []) {
    let recur = null;
    if (r.every) {
      if (r.every === 'daily') recur = { freq: 'daily', interval: 1, time: r.time || '09:00' };
      else if (r.every === 'week') recur = { freq: 'weekly', interval: 1, days: (r.days && r.days.length) ? r.days : [], time: r.time || '09:00' };
    }
    c.reminder.push({ title: r.title || '', at: iso(r.at), recur, status: r.active === false ? 'done' : 'active' });
  }
  for (const n of old.notes || []) c.note.push({ title: n.title || '', body: n.body || '', private: !!n.private, tags: n.tags || [] });
  for (const p of old.people || []) c.person.push({ name: p.name || '', phone: p.phone || '', birthday: p.birthday || '', notes: p.notes || '' });
  for (const m of old.money || []) c.money.push({ kind: m.kind === 'income' ? 'income' : 'expense', amount: Math.abs(m.amount || 0), category: m.cat || m.category || '', date: iso(m.date) || nowIso() });
  for (const d of old.debts || []) c.debt.push({ person: d.person || '', amount: Math.abs(d.amount || 0), dir: d.dir === 'i_owe_them' ? 'i_owe_them' : 'they_owe_me', status: d.settled ? 'settled' : 'open', date: iso(d.date) || nowIso() });
  for (const s of old.stock || []) c.stockItem.push({ name: s.name || '', qty: +s.qty || 0, unit: s.unit || 'unit', lowThreshold: s.low != null ? s.low : null });
  for (const h of old.habits || []) c.habit.push({ name: h.name || '', schedule: { freq: 'daily', interval: 1 }, log: (h.log || []).map(iso).filter(Boolean) });
  for (const j of old.journal || []) c.journal.push({ text: j.text || '', mood: j.mood || '', date: iso(j.date) || nowIso() });
  for (const e of old.events || []) c.event.push({ title: e.title || '', kind: e.kind || e.note || '', at: iso(e.date), allDay: true });
  return c;
}

/** Read + migrate the legacy localStorage payload, if present. Returns {collections, settings} or null. */
export function readLegacy(storage) {
  try {
    const raw = (storage || globalThis.localStorage).getItem('brain.state.v1');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const collections = migrateLegacy(parsed);
    if (!collections) return null;
    const settings = { name: parsed && parsed.name ? parsed.name : '', onboarded: !!(parsed && parsed.name) };
    return { collections, settings };
  } catch (e) { return null; }
}

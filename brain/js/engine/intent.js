// Brain intent engine — deterministic, offline, natural-language understanding.
// It reads text, optionally completes it using the conversational Context
// (clarifications, "that/it/last one", corrections), and performs actions via
// the actions layer, returning a {text, cards} reply for the UI to render.
// Text in replies is PLAIN (safe) — the UI escapes it before display.

import * as A from './actions.js';
import { Context } from './context.js';
import { searchAll } from './search.js';
import * as D from '../util/date.js';
import { parseRecur, resolveMoment, timeFromText } from '../util/date.js';
import { parseNum, cleanName, todayKey, normStr } from '../util/util.js';

function reply(text, cards, run) { return { text, cards: cards || [], run: run || null }; }

// ---------- external / device actions ----------
// The engine stays pure: it resolves the *target* and returns a `run` request
// { id, label, args } that the app shell executes against the device APIs
// (capability-gated). When a reference is ambiguous it returns the matching
// entity cards and asks, instead of guessing.

function mon(d) { return d.getMonth() + '/' + d.getFullYear(); }
function fmtDate(store, d) { try { return new Date(d).toLocaleDateString(store.settings.locale || 'en-IN', { day: 'numeric', month: 'short' }); } catch { return ''; } }
function relOf(store, d) {
  const now = new Date(); const diff = D.daysBetween(new Date(now.getFullYear(), now.getMonth(), now.getDate()), d) ;
  if (diff === 0) return 'today'; if (diff === 1) return 'tomorrow'; if (diff === -1) return 'yesterday';
  return diff > 1 ? `in ${diff} days` : `${-diff} days ago`;
}

export class Brain {
  constructor(store) {
    this.store = store;
    this.ctx = new Context();
    this.name = store.settings.name;
  }
  get cur() { return this.store.settings.currency; }

  /** Main entry. Returns a reply object. */
  async handle(text) {
    const s = this.store;
    const t = String(text || '').trim();
    if (!t) return reply('');
    const low = t.toLowerCase();

    // ---- Destructive confirmations first ----
    if (this.ctx.pending && this.ctx.pending.kind === 'confirm_delete' && /^(yes|yep|yeah|confirm|ok|sure|do it|go ahead)\b/.test(low)) {
      return this._doDelete(this.ctx.pending.target);
    }
    if (this.ctx.pending && this.ctx.pending.kind === 'confirm_delete' && /^(no|nope|cancel|never mind|no delete)\b/.test(low)) {
      this.ctx.clearPending();
      return reply('Okay, nothing deleted.');
    }

    // ---- Clarifying answers to pending reminder-time ----
    if (this.ctx.pending && this.ctx.pending.kind === 'reminder_time') {
      const when = t;
      if (!/^(remind me|add task|i (need|have) to|note|remember|spent|sold|delete|show|what)/.test(low)) {
        return this._finishReminder(this.ctx.pending.params, when);
      }
    }

    // ---- Simple meta / smalltalk ----
    const meta = this._meta(low, t);
    if (meta) return meta;

    // ---- Imperative device actions: call / text / whatsapp / email / maps /
    // share / open / copy / calendar / photo. Resolved against stored people.
    const act = this._externalAction(low, t);
    if (act) return act;

    // ---- Queries ----
    const q = this._query(low, t);
    if (q) return q;

    // ---- Corrections / follow-ups on last item ----
    const corr = this._correction(low, t);
    if (corr) return corr;

    // ---- Data intents ----
    const create = this._create(low, t);
    if (create) return create;

    return reply("I didn't quite catch that. Try “remind me to call mom at 7pm”, “spent 300 on groceries”, “Priya's birthday is March 12”, or “what's coming up?”");
  }

  // ---------- meta ----------
  _meta(low, t) {
    if (/^(hi|hello|hey|namaste|yo|good (morning|afternoon|evening)|hola)\b/.test(low)) {
      const n = this.name ? `, ${this.name}` : ''; return reply(`Hey${n} 👋 What can I do for you?`);
    }
    if (/thank|thanks|thx|dhanyavad|shukriya/i.test(low)) return reply('Anytime 😊');
    if (/who are you|what are you|are you an ai|is this an ai|how do you work/.test(low))
      return reply("I'm Brain — a private assistant living entirely on this device. No account, no cloud. I understand natural language and manage your tasks, reminders, notes, contacts, money, and more offline.");
    if (/what can you do|help|how do i use|features|commands/.test(low)) return this._help();
    if (/offline|internet|online|cloud|data|private|privacy/.test(low) && /\?$/.test(t))
      return reply("Everything stays on your device. No data is sent anywhere. You can back it up and restore it yourself in Settings.");
    if (/\bhi brain\b|\bhey brain\b/.test(low)) return reply(`Hello${this.name ? ', ' + this.name : ''}!`);
    return null;
  }
  _help() {
    return reply(`I can help with a lot. Try things like:

Reminders — “remind me to call mom tomorrow at 7pm”, “every monday at 9am water the plants”
Tasks — “add task finish the report by friday”, “submit the assignment”
Notes — “remember the wifi password is Home123”, “save a recipe: …”
People — “Priya's birthday is March 12”, “John's number is 9876…”
Money — “spent 850 on groceries”, “salary came in 45000”, “Ravi owes me 500”
Stock — “I have 5kg rice”, “used 2kg rice”
Health — “took paracetamol at 8am”, “walked 8000 steps”, “weight 68kg”
Habits — “did yoga today”
Journal — “I felt great today”
Search & questions — “what's coming up?”, “how much did I spend this month?”, “show everything about John”, “who owes me?”`);
  }

  /** Find people matching a loose contact token (name, phone, email, alias). */
  _findPeople(token) {
    const s = this.store;
    const q = normStr(token);
    const isNum = /^\+?[\d\s().-]{7,}$/.test(String(token || '').trim());
    const out = [];
    for (const p of s.list('person')) {
      if (!p) continue;
      if (normStr(p.name) === q) { out.unshift(p); continue; }
      const hays = normStr(p.name + ' ' + (p.phone || '') + ' ' + (p.email || '') + ' ' + (p.relationship || ''));
      if (hays.includes(q) && q.length >= 2) out.push(p);
      else if (isNum && normStr(p.phone).replace(/\s/g, '') === q) out.push(p);
    }
    // dedupe by id, prefer name-first match
    const seen = new Set(); const uniq = [];
    for (const p of out) if (!seen.has(p.id)) { seen.add(p.id); uniq.push(p); }
    return uniq;
  }

  /** Human summary of an external launch request to show above the action. */
  _describeAction(id, who) {
    const nm = who ? (who.name || who) : '';
    switch (id) {
      case 'call': return `Calling ${nm}…`;
      case 'sms': return `Preparing a message to ${nm}…`;
      case 'whatsapp': return `Opening WhatsApp for ${nm}…`;
      case 'email': return `Preparing an email to ${nm}…`;
      case 'maps': return `Opening the map for ${nm}…`;
      default: return '';
    }
  }

  _externalAction(low, t) {
    const s = this.store;

    // ---- Call ----
    let m = t.match(/^(?:call|ring|dial|phone|ring up)\s+(?:up\s+|my\s+)?(.+?)\s*$/i);
    // but not "remind me to call"/"remember to call"/"task to call" (those are creates)
    const isPlainImperative = /^(call|ring|dial|phone)\b/.test(low) && !/^(remind|remember|task|to-d?o)\b/.test(low);
    if (m && isPlainImperative) {
      const who = m[1].replace(/[?!.]+$/, '').trim();
      // If it looks like a scheduled "call X at time/date", that's a reminder-style
      // request, not an immediate dial.
      if (/\b(at|by|tonight|tomorrow|today|this|next|soon|\d|am|pm)\b/i.test(who)) return null;
      const direct = who.replace(/[^\d+]/g, '');
      if (/^\+?[\d]{7,}$/.test(direct)) {
        this.ctx.push('person', null, who);
        return reply(this._describeAction('call', who), [], { id: 'call', label: '📞 Call ' + who, args: { number: direct } });
      }
      const found = this._findPeople(who);
      if (found.length === 1 && found[0].phone) {
        const p = found[0]; this.ctx.push('person', p.id, p.name);
        return reply(this._describeAction('call', p.name), [], { id: 'call', label: '📞 Call ' + p.name, args: { number: p.phone } });
      }
      if (found.length > 1) return reply(`Which ${found[0].name.split(' ')[0]}? I found several:`, found.map(p => ({ kind: 'person', id: p.id })));
      if (found.length === 1 && !found[0].phone) return reply(`I know ${found[0].name} but don’t have their number yet. Say “${found[0].name.split(' ')[0]}’s number is 98…” to add it.`);
      return reply(`I don’t know who “${who}” is. Add them first, e.g. “John’s number is 9876500001”.`);
    }

    // ---- Text / SMS ----
    m = t.match(/^(?:text|sms|message)\s+(.+?)(?:\s+(?:that|saying|the message|:\s*))?\s*(.+)?$/i);
    if (m && /^(text|sms|message)\b/.test(low)) {
      const who = m[1].replace(/[?!.]+$/, '').trim();
      const body = (m[2] || '').replace(/["“”']/g, '').trim();
      const direct = who.replace(/[^\d+]/g, '');
      if (/^\+?[\d]{7,}$/.test(direct)) {
        return reply(this._describeAction('sms', who), [], { id: 'sms', label: '💬 Text ' + who, args: { number: direct, body } });
      }
      const found = this._findPeople(who);
      if (found.length === 1 && found[0].phone) return reply(this._describeAction('sms', found[0].name), [], { id: 'sms', label: '💬 Text ' + found[0].name, args: { number: found[0].phone, body } });
      if (found.length > 1) return reply(`Which ${found[0].name.split(' ')[0]}?`, found.map(p => ({ kind: 'person', id: p.id })));
      if (found.length === 1) return reply(`No number for ${found[0].name} yet — add it first.`);
      return reply(`I don’t have a contact matching “${who}”.`);
    }

    // ---- WhatsApp ----
    m = t.match(/^(?:whatsapp|whatsapp\s+message|message\s+on\s+whatsapp|wa)\s+(.+?)(?:\s+(?:that|saying)\s+)?(.*)$/i);
    if (m && /^(whatsapp|message .*whatsapp|wa)\b/.test(low) && !/^(remind|remember)\b/.test(low)) {
      const who = m[1].replace(/[?!.]+$/, '').trim();
      const body = (m[2] || '').replace(/["“”']/g, '').trim();
      const direct = who.replace(/[^\d+]/g, '');
      if (/^\+?[\d]{7,}$/.test(direct)) return reply(this._describeAction('whatsapp', who), [], { id: 'whatsapp', label: '🟢 WhatsApp ' + who, args: { number: direct, text: body } });
      const found = this._findPeople(who);
      if (found.length === 1 && found[0].phone) return reply(this._describeAction('whatsapp', found[0].name), [], { id: 'whatsapp', label: '🟢 WhatsApp ' + found[0].name, args: { number: found[0].phone, text: body } });
      if (found.length > 1) return reply(`Which ${found[0].name.split(' ')[0]}?`, found.map(p => ({ kind: 'person', id: p.id })));
      if (found.length === 1) return reply(`No number for ${found[0].name}, and WhatsApp needs a number. Add it first.`);
      // No number at all → compose-on-web share link (honest fallback)
      return reply('I can open WhatsApp to compose a message to that contact.', [], { id: 'whatsapp', label: '🟢 WhatsApp', args: { number: null, text: body } });
    }

    // ---- Email ----
    m = t.match(/^(?:email|e-?mail|mail)\s+(.+?)(?:\s+(?:about|the|that|re:)\s+)?(.*)$/i);
    if (m && /^(email|mail)\b/.test(low)) {
      let who = m[1].replace(/[?!.]+$/, '').trim();
      let extra = m[2] || '';
      if (/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(who)) {
        return reply('Preparing an email…', [], { id: 'email', label: '✉️ Email', args: { email: who, subject: '', body: extra } });
      }
      // who may be "Sarah the project update" → name=Sarah, rest=subject
      const nameMatch = who.match(/^([a-z][a-z .'-]+?)\s+(?:the\s+)?(.+)$/i);
      const name = nameMatch ? nameMatch[1].trim() : who;
      const subj = nameMatch ? nameMatch[2].trim() : extra;
      const found = this._findPeople(name);
      if (found.length === 1 && found[0].email) return reply(this._describeAction('email', found[0].name), [], { id: 'email', label: '✉️ Email ' + found[0].name, args: { email: found[0].email, subject: subj, body: '' } });
      if (found.length > 1) return reply(`Which ${found[0].name.split(' ')[0]}?`, found.map(p => ({ kind: 'person', id: p.id })));
      if (found.length === 1) return reply(`No email for ${found[0].name} yet — add it first.`);
      return reply(`I don’t know ${name}’s email. Save it first, e.g. “${name}’s email is x@y.com”.`);
    }

    // ---- Maps / navigate ----
    m = t.match(/(?:navigate|get directions|route|take me|open in maps|go to)\s+(?:to\s+)?(?:the\s+)?(.*?)(?:\s*$)/i);
    if (m && /navigate|directions|route|maps|take me|go to/.test(low)) {
      const place = m[1].replace(/[?!.]+$/, '').trim();
      if (place) {
        const found = this._findPeople(place);
        if (found.length === 1 && found[0].address) return reply(this._describeAction('maps', found[0].name), [], { id: 'maps', label: '📍 Navigate to ' + found[0].name, args: { query: found[0].address } });
        if (found.length === 1 && !found[0].address) return reply(`I know ${found[0].name} but not their address. Say “${found[0].name.split(' ')[0]} lives at …” to add it.`);
        if (found.length > 1) return reply(`Which ${found[0].name.split(' ')[0]}?`, found.map(p => ({ kind: 'person', id: p.id })));
        return reply(this._describeAction('maps', place), [], { id: 'maps', label: '📍 Navigate to ' + place, args: { query: place } });
      }
    }
    // map an address directly "open maps for 12 Market Road"
    m = t.match(/(?:open|show)\s+(?:in\s+)?maps\s+(?:for|to)\s+(.+)/i) || t.match(/^(?:maps?|map)\s+(.+)/i);
    if (m) { const q = m[1].trim().replace(/[?!.]+$/, ''); if (q) return reply('Opening the map…', [], { id: 'maps', label: '📍 Navigate', args: { query: q } }); }

    // ---- Open (Instagram / web) ----
    if (/^(open|launch|go to)\s+(instagram|insta)\b/i.test(t)) {
      return reply('Opening Instagram…', [], { id: 'open', label: '📸 Open Instagram', args: { url: 'https://www.instagram.com/' } });
    }
    m = t.match(/open\s+(.+?)['’]s\s+instagram/i);
    if (m) {
      const found = this._findPeople(m[1]);
      // No stored handle → open Instagram and let the user search; be honest.
      return reply(found.length ? `Opening Instagram. I can’t jump straight into ${found[0].name}’s profile without their handle — you may need to search.` : 'Opening Instagram…', [], { id: 'open', label: '📸 Open Instagram', args: { url: 'https://www.instagram.com/' } });
    }
    m = t.match(/(?:open|visit|go to)\s+(https?:\/\/[^\s]+)/i);
    if (m) { const u = m[1].replace(/[)\]"'.,;]+$/, ''); return reply('Opening link…', [], { id: 'open', label: '🔗 Open', args: { url: u } }); }

    // ---- Copy ----
    if (/^(copy|copied)\b/.test(low)) {
      const what = t.replace(/^(copy|copied)\b/i, '').replace(/\s+/g, ' ').trim();
      if (/phone|number|contact/i.test(what)) {
        const name = what.replace(/phone|number|contact|the|of|for/gi, '').trim();
        if (name) { const f = this._findPeople(name); if (f.length === 1 && f[0].phone) return reply(`Copying ${f[0].name}’s number…`, [], { id: 'copy', label: '📋 Copy number', args: { text: f[0].phone } }); }
      }
      if (what) return reply('Copying…', [], { id: 'copy', label: '📋 Copy', args: { text: what } });
    }

    // ---- Add to calendar (reference an existing dated thing) ----
    if (/add .* to (my )?calendar|add to calendar|save (this )?.*calendar/i.test(t) && /calendar/i.test(low)) {
      const target = this.ctx.resolvePronoun(t, s) || (this.ctx.last.length ? this.ctx.last[0] : null);
      const rec = target ? s.list(target.type).find(x => x.id === target.id) : null;
      if (rec && (rec.at || rec.due)) {
        const at = new Date(rec.at || rec.due);
        return reply(`I’ve prepared a calendar file for “${rec.title || rec.name}” (${at.toLocaleDateString()}) — download & open it to add.`, [], { id: 'calendar', label: '📅 Add to calendar', args: { title: rec.title || rec.name, start: rec.at || rec.due, end: new Date(new Date(rec.at || rec.due).getTime() + 3600000).toISOString(), description: rec.note || '' } });
      }
      return reply('Tell me which dated item to add, or I’ll need a date. For example say “remind me to meet Sara on Friday” and then “add that to my calendar”.');
    }

    // ---- Share ----
    if (/^(share|send)\b/.test(low) || /^share /.test(low)) {
      // share today's plan / schedule
      if (/today['’]?s plan|my schedule|today|plans?/.test(low)) {
        const text = this._sharePlanText();
        if (text) return reply('Here’s today’s plan — use the share button to send it anywhere.', [], { id: 'share', label: '🔗 Share plan', args: { title: 'Brain — Today’s plan', text } });
      }
      const what = t.replace(/^(share|send)\b/i, '').trim().replace(/^this /i, '');
      if (/note/i.test(what)) {
        const last = this.ctx.last.find(x => x.type === 'note') || this.ctx.last[0];
        const rec = last ? s.list(last.type).find(x => x.id === last.id) : null;
        if (rec) return reply('Sharing…', [], { id: 'share', label: '🔗 Share', args: { title: rec.title || 'Note', text: rec.body || rec.title || '' } });
      }
      // share a person's number or anything with text
      const found = what ? this._findPeople(what) : [];
      if (found.length === 1) return reply('Sharing contact…', [], { id: 'share', label: '🔗 Share contact', args: { title: found[0].name, text: found[0].name + (found[0].phone ? ' · ' + found[0].phone : '') + (found[0].email ? ' · ' + found[0].email : '') } });
      if (what) return reply('Sharing…', [], { id: 'share', label: '🔗 Share', args: { title: 'Brain', text: what } });
    }

    return null;
  }

  /** Build a plain-text summary of today (reminders, tasks, events, low stock). */
  _sharePlanText() {
    const s = this.store; const day = todayKey(); const lines = [];
    const due = s.list('task').filter(x => x.status !== 'done' && x.due && todayKey(new Date(x.due)) === day);
    if (due.length) lines.push('Tasks: ' + due.map(x => x.title).join(', '));
    for (const e of s.list('event')) if (e.at && todayKey(new Date(e.at)) === day) lines.push('📅 ' + e.title);
    const rems = s.list('reminder').filter(r => r.status === 'active' && (r.at ? todayKey(new Date(r.at)) === day : true));
    if (rems.length) lines.push('Reminders: ' + rems.map(r => r.title).join(', '));
    const low = s.list('stockItem').filter(x => x.lowThreshold != null && x.qty <= x.lowThreshold);
    if (low.length) lines.push('Low stock: ' + low.map(x => x.name).join(', '));
    if (!lines.length) return 'A clear day — nothing scheduled.';
    return 'Today’s plan:\n' + lines.join('\n');
  }

  // ---------- queries ----------
  _query(low, t) {
    const s = this.store;
    const now = new Date();

    // Global search-ish: "show everything related to X" / "what do I know about X"
    let m = t.match(/everything (?:about|related to|on|for|with)\s+([a-z0-9 ]+?)\s*$/i) ||
            t.match(/what do i know about\s+(.+?)\s*$/i) ||
            t.match(/(?:search|find|looking for)\s+(.+?)\s*$/i);
    if (m) {
      const q = m[1].trim();
      const res = searchAll(q, s);
      if (!res.length) return reply(`Nothing found for “${q}”.`);
      return reply(`Found ${res.length} thing${res.length > 1 ? 's' : ''} about “${q}”:`, res.slice(0, 10).map(x => ({ kind: x.type, id: x.record.id })));
    }

    // Lists
    const listKinds = { reminders: 'reminder', tasks: 'task', notes: 'note', contacts: 'person', people: 'person', stock: 'stockItem', events: 'event', habits: 'habit', journal: 'journal' };
    for (const key in listKinds) {
      if (new RegExp('\\b(show|list|my|all|view)?\\s*' + key + '\\b').test(low) && /\b(show|list|view|open|my)\b/.test(low)) {
        const type = listKinds[key];
        const items = s.list(type);
        if (!items.length) return reply(`Nothing here yet. ` + (key === 'reminders' ? 'Try “remind me to call mom at 7pm”.' : key === 'tasks' ? 'Try “add task finish the report”.' : 'Try adding something first.'));
        return reply(`Here ${key === 'journal' ? 'are your recent entries' : 'you go'}:`, items.slice(0, 12).map(x => ({ kind: type, id: x.id })));
      }
    }

    // Who owes me / debts summary
    if (/who owes me|what do people owe me|my debts|balance|who do i owe|debt summary/.test(low)) return this._debtsSummary();

    // Spending queries
    if (/how much (did i|have i) (spen|spend)|spent|spending|expenses|total spend|money/.test(low) && /this (month|week|year)|today|yesterday|total|in (?:the last|past)|all time/.test(low)) return this._spendReport(low);

    // today's / upcoming / coming up
    if (/what('| i)?s coming up|what'?s (on|up) today|anything (today|this week)|today'?s plan|what do i need to do today|what'?s next|upcoming/.test(low)) return this._todayPlan(7);

    // what did I do yesterday / today
    m = t.match(/what did i do (yesterday|today)|what (did i do|happened) (yesterday|today)|(?:log|diary).*?(yesterday|today)/i);
    if (m) return this._dayRecap(/yesterday/.test(low) ? -1 : 0);

    // Birthdays upcoming/this month
    if (/birthdays? (this month|coming|soon|upcoming)|who has a birthday/.test(low)) return this._birthdaysReport();

    // next appointment/event/doctor
    if (/next (doctor|appointment|meeting|dentist|visit|exam|class|flight|trip|event|reminder)/.test(low) || /when('| i)?s my next/.test(low)) return this._nextEvent(low);

    // low stock / running low / what's low
    if (/running low|low stock|what('| i)?s low|what do i need|out of stock|restock/.test(low)) return this._lowStock();

    // habit streak
    if (/streak|did i (do|log)|habit/.test(low) && /streak/.test(low)) return this._streaks();

    // phone number / person detail
    m = t.match(/(?:what'?s|what is|give me|show)\s+(?:the\s+)?phone\s+(?:number\s+)?(?:of|for)?\s*([a-z0-9 ]+?)\s*$/i) ||
        t.match(/([a-z0-9 ]+?)(?:'s)?\s+(?:phone|number|mobile)\s*\??$/i);
    // person birthday lookup handled by person search below via generic
    return null;
  }

  _debtsSummary() {
    const s = this.store; const owed = [], owe = [];
    for (const d of s.list('debt')) if (d.status !== 'settled') { (d.dir === 'they_owe_me' ? owed : owe).push(d); }
    if (!owed.length && !owe.length) return reply('No open debts. Nice.');
    const lines = [];
    let t = 0;
    for (const d of owed) { lines.push(`${d.person} owes you ${moneyToken(d.amount)}`); t += d.amount; }
    let t2 = 0;
    for (const d of owe) { lines.push(`you owe ${d.person} ${moneyToken(d.amount)}`); t2 += d.amount; }
    if (t || t2) lines.push(`Net: they owe you ${moneyToken(Math.max(0, t - t2))}, you owe ${moneyToken(Math.max(0, t2 - t))}`);
    return reply(lines.join('\n'));
  }

  _spendReport(low) {
    const s = this.store; const now = new Date();
    let filter; let label = 'this month';
    if (/yesterday/.test(low)) { const d = new Date(now); d.setDate(d.getDate() - 1); filter = k => k === todayKey(d); label = 'yesterday'; }
    else if (/this week/.test(low)) { const start = new Date(now); start.setDate(start.getDate() - now.getDay()); filter = k => new Date(k) >= start && new Date(k) <= now; label = 'this week'; }
    else if (/this year/.test(low)) { filter = k => new Date(k).getFullYear() === now.getFullYear(); label = 'this year'; }
    else if (/today/.test(low)) { filter = k => k === todayKey(now); label = 'today'; }
    else { filter = k => mon(now) === mon(new Date(k)); }
    let exp = 0, inc = 0, n = 0;
    for (const mo of s.list('money')) { if (filter(todayKey(new Date(mo.date)))) { if (mo.kind === 'income') inc += mo.amount; else exp += mo.amount; n++; } }
    return reply(`${cap(label)}: out ${moneyToken(exp)}, in ${moneyToken(inc)}, net ${moneyToken(inc - exp)}. (${n} transaction${n === 1 ? '' : 's'})`);
  }

  _todayPlan(range) {
    const s = this.store; const now = new Date(); const end = new Date(now); end.setDate(end.getDate() + range);
    const lines = []; const cards = [];
    // due/open tasks
    const tasks = s.list('task').filter(x => x.status !== 'done' && x.due && new Date(x.due) <= end).sort((a, b) => new Date(a.due) - new Date(b.due));
    for (const x of tasks.slice(0, 10)) { lines.push(`• ${x.title} — ${fmtDate(this.store, new Date(x.due))}${relOf(this.store, new Date(x.due)) === 'today' ? ' (today)' : relOf(this.store, new Date(x.due)) === 'tomorrow' ? ' (tomorrow)' : ''}`); cards.push({ kind: 'task', id: x.id }); }
    // reminders active / recurring due
    const rems = s.list('reminder').filter(r => r.status !== 'done');
    for (const r of rems.slice(0, 8)) { cards.push({ kind: 'reminder', id: r.id }); }
    // events in range
    const ev = s.list('event').filter(e => e.at && new Date(e.at) >= now && new Date(e.at) <= end).sort((a, b) => new Date(a.at) - new Date(b.at));
    for (const e of ev.slice(0, 8)) { lines.push(`📅 ${e.title} — ${fmtDate(this.store, new Date(e.at))}`); cards.push({ kind: 'event', id: e.id }); }
    if (!lines.length && !cards.length) return reply('Nothing on the horizon right now 👌');
    return reply(lines.length ? lines.join('\n') : 'Here’s what’s around:', cards);
  }

  _dayRecap(offset) {
    const s = this.store; const d = new Date(); d.setDate(d.getDate() + offset); const key = todayKey(d);
    const lines = [];
    for (const j of s.list('journal')) if (todayKey(new Date(j.date)) === key) lines.push(j.text);
    const exp = s.list('money').filter(x => x.kind === 'expense' && todayKey(new Date(x.date)) === key).reduce((a, x) => a + x.amount, 0);
    const inc = s.list('money').filter(x => x.kind === 'income' && todayKey(new Date(x.date)) === key).reduce((a, x) => a + x.amount, 0);
    if (exp || inc) lines.push(`money: ${inc ? 'in ' + moneyToken(inc) + ', ' : ''}${exp ? 'out ' + moneyToken(exp) : ''}`);
    const done = s.list('task').filter(x => x.completedAt && todayKey(new Date(x.completedAt)) === key);
    for (const x of done) lines.push(`completed: ${x.title}`);
    if (!lines.length) return reply(offset < 0 ? 'Nothing logged yesterday.' : 'Nothing logged yet today.');
    return reply(offset < 0 ? 'Yesterday:' : 'Today so far:\n' + lines.join('\n'));
  }

  _birthdaysReport() {
    const s = this.store; const out = [];
    for (const p of s.list('person')) {
      if (!p.birthday) continue;
      const nb = A.nextBirthdayFor(p.birthday);
      if (nb) out.push({ p, nb });
    }
    out.sort((a, b) => a.nb - b.nb);
    if (!out.length) return reply('No birthdays saved yet. Tell me “Priya’s birthday is March 12”.');
    return reply('Birthdays:\n' + out.slice(0, 12).map(x => `• ${x.p.name} — ${fmtDate(this.store, x.nb)} (${relOf(this.store, x.nb)})`).join('\n'));
  }

  _nextEvent(low) {
    const s = this.store; const now = new Date();
    const ev = s.list('event').filter(e => e.at && new Date(e.at) >= now).sort((a, b) => new Date(a.at) - new Date(b.at));
    const kindM = low.match(/(doctor|appointment|meeting|dentist|visit|exam|class|flight|trip|event)/);
    const target = ev.find(e => !kindM || (e.kind && e.kind.toLowerCase().includes(kindM[1])) || e.title.toLowerCase().includes(kindM[1])) || ev[0];
    if (!target) return reply('Nothing scheduled yet. Tell me an event and its date.');
    return reply(`Next: ${target.title} — ${fmtDate(this.store, new Date(target.at))} (${relOf(this.store, new Date(target.at))}).`, [{ kind: 'event', id: target.id }]);
  }

  _lowStock() {
    const s = this.store; const low = s.list('stockItem').filter(x => x.lowThreshold != null && x.qty <= x.lowThreshold);
    if (!low.length) return reply('Nothing is running low. 🎉');
    return reply('Running low:\n' + low.map(x => `• ${x.name} — ${x.qty} ${x.unit}`).join('\n'), low.map(x => ({ kind: 'stockItem', id: x.id })));
  }

  _streaks() {
    const s = this.store; const hs = s.list('habit');
    if (!hs.length) return reply('No habits tracked yet. Try “did yoga today”.');
    return reply('Habit streaks:\n' + hs.map(h => `• ${h.name} — ${A.streakOf(h.log)} day${A.streakOf(h.log) === 1 ? '' : 's'}`).join('\n'));
  }

  // ---------- corrections / follow-up ----------
  _correction(low, t) {
    const s = this.store; const last = this.ctx.last[0];
    // "Actually make that/it X" -> edit last money amount
    const amtM = t.match(/(?:actually\s+)?(?:make that|make it|change it|update it|set it|change that|make this|it'?s)\s*(?:to)?\s*[₹$€£]?\s*([\d.,]+)/i);
    if (amtM && last) {
      if (last.type === 'money') { const v = parseNum(amtM[1]); s.updateSync('money', last.id, { amount: Math.abs(v) }); this.ctx.push('money', last.id, 'money'); return reply(`Updated to ${moneyToken(v)}.`); }
    }
    // "mark it done" / "complete it" / "done" (last)
    if (/\b(mark|mark it|mark that)\s+(done|complete)\b|(?:^| )(done|complete|finish it|finish that)\b/.test(low) && last) {
      if (last.type === 'task') { A.completeTask(s, last.id); return reply(`Marked “${s.list('task').find(x => x.id === last.id).title}” done.`); }
      if (last.type === 'reminder') { s.updateSync('reminder', last.id, { status: 'done' }); return reply('Reminder done.'); }
    }
    // "reopen / uncomplete" last task
    if (/\b(reopen|uncomplete|undo|open again)\b/.test(low) && last && last.type === 'task') { A.reopenTask(s, last.id); return reply('Reopened.'); }
    // "delete that/it/the last one"
    if (/\b(delete|remove|clear|cancel)\s+(that|it|this|the last one)\b|\bdelete (it|that)\b/.test(low) && last) {
      this.ctx.pending = { kind: 'confirm_delete', target: last };
      return reply(`Delete ${this._label(last)}?`, [{ kind: last.type, id: last.id }]);
    }
    // generic delete with name handled in _create delete
    return null;
  }

  _doDelete(target) {
    const s = this.store;
    s.removeSync(target.type, target.id);
    this.ctx.last = this.ctx.last.filter(x => !(x.type === target.type && x.id === target.id));
    this.ctx.clearPending();
    return reply(`Deleted ${this._label(target)}.`);
  }
  _label(ref) { return ref.label || (this.store.list(ref.type).find(x => x.id === ref.id) || {}).title || (this.store.list(ref.type).find(x => x.id === ref.id) || {}).name || 'that'; }

  // ---------- create / delete intents ----------
  _create(low, t) {
    const s = this.store;
    const now = new Date();

    // ---- DELETION (named) ----
    if (/^(delete|remove|clear|forget|cancel|erase)\b/.test(low)) {
      const raw = t.replace(/^(delete|remove|clear|forget|cancel|erase)\s+/i, '').replace(/^(the|my|that|this|a|an)\s+/i, '');
      const cat = /(task|reminder|note|contact|person|event|debt|habit)/i.exec(low);
      let target = null;
      const phrase = raw.replace(/^(task|reminder|note|contact|person|event)\s+(about|for|to|:)?\s*/i, '').trim();
      const types = cat ? [cat[1]] : ['task', 'reminder', 'note', 'person', 'event', 'debt'];
      const fieldOf = type => type === 'person' ? 'name' : type === 'debt' ? 'person' : 'title';
      for (const type of types) {
        const field = fieldOf(type);
        const found = s.list(type).find(x => String(x[field]).toLowerCase().includes(phrase.toLowerCase()));
        if (found) { target = { type, id: found.id, label: found[field] }; break; }
      }
      if (target) { this.ctx.pending = { kind: 'confirm_delete', target }; return reply(`Delete ${this._label(target)}?`, [{ kind: target.type, id: target.id }]); }
      return reply("I couldn't find that to delete. Try naming it clearly, e.g. “delete my task about the report”.");
    }

    // ---- WAKE / bare alarm-ish ----
    const wake = t.match(/\bwake me up\s+(?:at\s+)?(.+)/i);
    if (wake) { const time = timeFromText(wake[1]); if (time) { const at = new Date(now); at.setHours(time.h, time.min, 0, 0); if (at <= now) at.setDate(at.getDate() + 1); const r = A.createReminder(s, { title: 'Wake up', at }); return reply(r.text); } return this._askReminderTime('Wake up'); }

    // ---- REMINDERS ----
    if (/\bremind me\b/.test(low) || /remind me to|set (a )?reminder|don'?t let me forget/.test(low)) {
      let m = t.match(/\bremind me\s+(?:to|that|about)\s+(.+?)\s*$/i);
      const title = m ? cleanRemTitle(m[1]) : cleanRemTitle(t.replace(/\bremind me\b|set (a )?reminder/i, '').replace(/\bto\s*/i, ''));
      if (!title) return reply('Remind you to do what?');
      return this._addReminder(title, t);
    }

    // ---- TASKS ----
    const taskRes = this._tryTask(low, t);
    if (taskRes) return taskRes;

    // ---- NOTES / MEMORY ----
    const noteRes = this._tryNote(low, t);
    if (noteRes) return noteRes;

    // ---- PEOPLE / birthdays ----
    const personRes = this._tryPerson(low, t);
    if (personRes) return personRes;

    // ---- MONEY / debts ----
    const moneyRes = this._tryMoney(low, t);
    if (moneyRes) return moneyRes;

    // ---- STOCK ----
    const stockRes = this._tryStock(low, t);
    if (stockRes) return stockRes;

    // ---- HEALTH ----
    const healthRes = this._tryHealth(low, t);
    if (healthRes) return healthRes;

    // ---- HABITS ----
    const habitRes = this._tryHabit(low, t);
    if (habitRes) return habitRes;

    // ---- JOURNAL / MOOD ----
    const journalRes = this._tryJournal(low, t);
    if (journalRes) return journalRes;

    return null;
  }

  _addReminder(title, fullText) {
    const s = this.store; const now = new Date();
    // recurring?
    const recur = parseRecur(fullText, now);
    if (recur) {
      // resolve time (explicit or implicit), else 9am default
      let time = recur.time;
      if (!time) time = D.clockString(fullText);
      if (!time) time = null;
      const params = { title, recur: Object.assign({}, recur, { time }) };
      if (!time && !/morning|evening|tonight|afternoon/.test(low2(fullText))) return this._askReminderTime(title, recur);
      const r = A.createReminder(s, { title, recur: params.recur });
      this.ctx.push('reminder', r.id, title);
      return reply(r.text, [{ kind: 'reminder', id: r.id }]);
    }
    // one-off
    const res = resolveMoment(fullText, now);
    if (res.matched && (res.hasTime || /tomorrow|tonight|today|[a-z]day|weekend|week|month|march|jan|feb|apr|may|jun|jul|aug|sep|oct|nov|dec|in \d+|\/|-/i.test(fullText))) {
      // has a day/date or a clock
      if (!res.hasTime && !/morning|afternoon|evening|tonight|noon|midnight/.test(low2(fullText))) return this._askReminderTime(title, null, res.date);
      const r = A.createReminder(s, { title, at: res.date });
      this.ctx.push('reminder', r.id, title);
      return reply(r.text, [{ kind: 'reminder', id: r.id }]);
    }
    // no day & no time -> ask
    return this._askReminderTime(title);
  }
  _askReminderTime(title, recur, atHint) {
    this.ctx.pending = { kind: 'reminder_time', params: { title, recur, atHint } };
    return reply(`When should I remind you about “${title}”? (e.g. 7pm, tomorrow 9am, every monday at 9)`);
  }
  _finishReminder(params, whenText) {
    const s = this.store; const now = new Date();
    const recur = parseRecur('every ' + whenText, now) || params.recur;
    if (recur) {
      let time = recur.time || D.clockString(whenText) || '09:00';
      const rr = Object.assign({}, recur, { time });
      const r = A.createReminder(s, { title: params.title, recur: rr });
      this.ctx.clearPending(); this.ctx.push('reminder', r.id, params.title);
      return reply(r.text, [{ kind: 'reminder', id: r.id }]);
    }
    const res = resolveMoment(whenText, now);
    if (!res.matched) { this.ctx.clearPending(); return reply('I didn’t get that as a time. Want to try again or skip this?'); }
    const r = A.createReminder(s, { title: params.title, at: res.date });
    this.ctx.clearPending(); this.ctx.push('reminder', r.id, params.title);
    return reply(r.text, [{ kind: 'reminder', id: r.id }]);
  }

  _tryTask(low, t) {
    const s = this.store; const now = new Date();
    if (/remind me/.test(low)) return null;
    let body = null;
    let m = t.match(/(?:add|create|new)\s+(?:a\s+|the\s+)?(?:task|to-?do)\s*[:,-]?\s*(.+?)\s*$/i);
    if (m) body = m[1];
    if (!body) {
      m = t.match(/(?:i need to|i have to|i must|need to|got to|must)\s+(.+?)\s*$/i);
      if (m) body = m[1];
    }
    if (!body) {
      // imperative verb start like "submit the assignment", "book tickets"
      m = t.match(/^(submit|finish|complete|buy|book|fix|pay|schedule|send|file|wash|clean|water|call|email|write|buy|collect|renew|repair|install|order|cook|study|revise|practice|plan|prepare|return|pick up)\s+(.+?)\s*$/i);
      if (m) body = m[1] + ' ' + m[2];
    }
    if (!body) return null;
    // split trailing due phrase
    const parts = splitDue(body);
    const title = cap(parts.title);
    let due = null; let dueTxt = '';
    if (parts.due) {
      const res = resolveMoment(parts.due, now);
      if (res.matched && (res.hasTime || /tomorrow|today|tonight|[a-z]day|weekend|week|month|in \d+|\/|\d/.test(parts.due))) { due = res.date; dueTxt = res.date; }
    }
    const r = A.createTask(s, { title, due });
    if (dueTxt) dueTxt = fmtDate(this.store, dueTxt);
    this.ctx.push('task', r.id, title);
    return reply(r.text, [{ kind: 'task', id: r.id }]);
  }

  _tryNote(low, t) {
    const s = this.store;
    let m = t.match(/^(remember|note|note down|save|store|keep|jot down|write down)\s*(?:that\s*)?[:,-]?\s*(.+)$/i);
    if (m) {
      const content = m[2].trim();
      const isPrivate = /password|pin|passcode|wifi|otp|secret|private|card (number|no)|cvv/i.test(low);
      const r = A.saveNote(s, { title: '', body: content, isPrivate });
      return reply(r.text, [{ kind: 'note', id: r.id }]);
    }
    // wifi password
    m = t.match(/(?:wifi|wi-?fi)\s*(?:password|pass|key)?\s*(?:is|=|:)?\s*[:,-]?\s*([\w@#$%^&*!.\-]{4,})/i);
    if (m && /wifi/.test(low)) { const r = A.saveNote(s, { title: 'WiFi password', body: m[1], isPrivate: true }); this.ctx.push('note', r.id, 'WiFi password'); return reply('Saved 🔒', [{ kind: 'note', id: r.id }]); }
    // recipe/address specifics
    m = t.match(/recipe\s*:?\s*(.+)$/i);
    if (m && /recipe/.test(low)) { const r = A.saveNote(s, { title: 'Recipe', body: m[1].trim(), tags: ['recipe'] }); return reply(r.text, [{ kind: 'note', id: r.id }]); }
    m = t.match(/(?:parking spot|parking)\s+(?:is|=)\s+(.+)/i);
    if (m) { const r = A.saveNote(s, { title: 'Parking spot', body: m[1].trim() }); return reply(r.text, [{ kind: 'note', id: r.id }]); }
    return null;
  }

  _tryPerson(low, t) {
    const s = this.store;
    // birthday
    let m = t.match(/([a-z][a-z ]+?)(?:'s|')?\s+birthday\s+(?:is|on|falls on)?\s+(.+?)\s*$/i);
    if (m && /birthday/.test(low)) {
      const name = cleanName(m[1].replace(/'s$/i, ''));
      const bdRaw = m[2].trim();
      if (/^(me|my|mine)$/i.test(name)) return this._addMyBirthday(bdRaw);
      if (this._isCommon(name)) return null;
      let p = this._ensurePerson(name);
      p = s.updateSync('person', p.id, { birthday: bdRaw });
      this.ctx.push('person', p.id, name);
      return reply(`Saved: ${name}'s birthday ${bdRaw}.`, [{ kind: 'person', id: p.id }]);
    }
    // phone number detail
    m = t.match(/([a-z][a-z ]+?)(?:'s)?\s+(?:phone|number|mobile|contact)\s*(?:number)?\s*(?:is|=)\s*([+\d][\d\s-]{6,})/i);
    if (m) { const name = cleanName(m[1]); const num = m[2].replace(/\s/g, ''); const p = this._ensurePerson(name); s.updateSync('person', p.id, { phone: num }); this.ctx.push('person', p.id, name); return reply(`Saved ${name}'s number ${num}.`, [{ kind: 'person', id: p.id }]); }
    // add contact explicit
    m = t.match(/(?:add|save|new)\s+contact\s*[:,-]?\s*([a-z][a-z ]+?)(?:\s*,\s*([+\d][\d\s-]{6,}))?/i);
    if (m && /contact/.test(low)) { const name = cleanName(m[1]); const p = this._ensurePerson(name); if (m[2]) s.updateSync('person', p.id, { phone: m[2].replace(/\s/g, '') }); this.ctx.push('person', p.id, name); return reply(`Saved contact ${p.name}.`, [{ kind: 'person', id: p.id }]); }
    // email
    m = t.match(/([a-z][a-z .'-]+?)(?:'s)?\s+email\s*(?:address\s*)?(?:is|is at)?\s*([\w.+-]+@[\w-]+\.[\w.]+)/i);
    if (m && /email/.test(low) && !/^(call|text|message|whatsapp|share)\b/.test(low)) {
      const name = cleanName(m[1].replace(/'s$/i, '')); if (this._isCommon(name)) return null;
      const em = m[2].toLowerCase(); const p = this._ensurePerson(name);
      s.updateSync('person', p.id, { email: em }); this.ctx.push('person', p.id, name);
      return reply(`Saved ${name}'s email ${em}.`, [{ kind: 'person', id: p.id }]);
    }
    // address / lives at
    m = t.match(/([a-z][a-z .'-]+?)\s+(?:lives at|address is|address:|home is|works at|place is)\s+(.+?)\s*$/i);
    if (m && /lives at|address|home is|works at|place is/i.test(low)) {
      const name = cleanName(m[1]); if (this._isCommon(name)) return null;
      const addr = m[2].replace(/[.!]+$/, '').trim(); const p = this._ensurePerson(name);
      s.updateSync('person', p.id, { address: addr }); this.ctx.push('person', p.id, name);
      return reply(`Saved ${name}'s address.`, [{ kind: 'person', id: p.id }]);
    }
    // misc person fact "X is allergic..." -> needs a known person; skip if ambiguous
    return null;
  }
  _addMyBirthday(bdRaw) {
    const e = A.createEvent(this.store, { title: (this.name || 'Your') + ' birthday', at: A.nextBirthdayFor(bdRaw), allDay: true, kind: 'birthday' });
    return reply(e.text + ' (annual reminder can be added on the event).', [{ kind: 'event', id: e.id }]);
  }
  _isCommon(n) { return /^(mom|dad|mum|mother|father|brother|sister|grandma|grandpa|friend|doctor|teacher|the|a|my|your)$/i.test(n); }
  _ensurePerson(name) {
    const s = this.store;
    let p = s.list('person').find(x => x.name.toLowerCase() === name.toLowerCase());
    if (!p) { p = s.addSync('person', { name }); }
    return p;
  }

  _tryMoney(low, t) {
    const s = this.store; const now = new Date();
    const amtIn = t.match(/(?:[₹$€£])\s*([\d.,]+)/) || t.match(/\b([\d.,]+)\s*(?:rupees|rs\.?|inr|dollars?)\b/i) || null;

    // repayment settles debt
    let m = t.match(/([a-z][a-z ]+?)\s+(?:paid\s+me(?: back)?|repaid|paid back)\s+([₹$€£]?\s*[\d.,]+)/i);
    if (m) { const nm = cleanName(m[1]); const debt = s.list('debt').find(d => d.dir === 'they_owe_me' && d.status !== 'settled' && d.person.toLowerCase() === nm.toLowerCase()); if (debt) { A.settleDebt(s, debt.id); return reply(`Recorded: ${nm} repaid you.`); } const v = parseNum(m[2]); A.logMoney(s, { kind: 'income', amount: v, category: 'repayment from ' + nm }); return reply(`Recorded ${moneyToken(v)} from ${nm}.`); }

    // "X owes me Y"
    m = t.match(/([a-z][a-z ]+?)\s+owes\s+me\s+[₹$€£]?\s*([\d.,]+)/i);
    if (m) { const nm = cleanName(m[1]); if (!this._isCommon(nm)) { this._ensurePerson(nm); const r = A.logDebt(s, { person: nm, amount: parseNum(m[2]), dir: 'they_owe_me' }); this.ctx.push('debt', r.id, nm); return reply(r.text, [{ kind: 'debt', id: r.id }]); } }
    // "I owe X Y"
    m = t.match(/\bi owe\s+([a-z][a-z ]+?)\s+[₹$€£]?\s*([\d.,]+)/i);
    if (m) { const nm = cleanName(m[1]); this._ensurePerson(nm); const r = A.logDebt(s, { person: nm, amount: parseNum(m[2]), dir: 'i_owe_them' }); this.ctx.push('debt', r.id, nm); return reply(r.text, [{ kind: 'debt', id: r.id }]); }
    // "lent X Y" (I lent) -> they owe me ; "X lent me Y" -> I owe X
    m = t.match(/([a-z][a-z ]+?)\s+lent\s+me\s+[₹$€£]?\s*([\d.,]+)/i);
    if (m) { const nm = cleanName(m[1]); this._ensurePerson(nm); const r = A.logDebt(s, { person: nm, amount: parseNum(m[2]), dir: 'i_owe_them' }); return reply(r.text, [{ kind: 'debt', id: r.id }]); }
    m = t.match(/(?:i\s+|)lent\s+([a-z][a-z ]+?)\s+[₹$€£]?\s*([\d.,]+)/i);
    if (m && !/\bme\b/.test(m[0])) { const nm = cleanName(m[1]); this._ensurePerson(nm); const r = A.logDebt(s, { person: nm, amount: parseNum(m[2]), dir: 'they_owe_me' }); return reply(r.text, [{ kind: 'debt', id: r.id }]); }

    // expense
    m = t.match(/(?:spen[dt]|spending)\s+(?:about\s+)?[₹$€£]?\s*([\d.,]+)\s*(?:on|for|at)\s*(.+?)\s*$/i);
    if (m) { const cat = m[2].trim().replace(/[.!]/g, ''); const r = A.logMoney(s, { kind: 'expense', amount: parseNum(m[1]), category: cat }); this.ctx.push('money', r.id, cat); return reply(r.text + ' (this month: ' + this._monthTotals() + ')', [{ kind: 'money', id: r.id }]); }
    m = t.match(/(?:spen[dt]|spending)\s+(?:about\s+)?[₹$€£]?\s*([\d.,]+)/i);
    if (m) { const r = A.logMoney(s, { kind: 'expense', amount: parseNum(m[1]), category: 'expense' }); this.ctx.push('money', r.id, 'expense'); return reply(r.text + ' (this month: ' + this._monthTotals() + ')', [{ kind: 'money', id: r.id }]); }
    // "paid electricity bill 1200" expense ; "paid X 800" where X person => maybe income they paid user; but phrase "paid 300 for groceries" user pays.
    m = t.match(/(?:paid|pays?)\s+[₹$€£]?\s*([\d.,]+)\s+(?:for\s+)?(.+?)\s*$/i);
    if (m) { const cat = m[2].trim().replace(/[.!]/g, ''); const r = A.logMoney(s, { kind: 'expense', amount: parseNum(m[1]), category: cat }); return reply(r.text, [{ kind: 'money', id: r.id }]); }
    // bought X for Y (expense) — also stock handled separately but allow expense too
    m = t.match(/\bbought\s+(.+?)\s+for\s+[₹$€£]?\s*([\d.,]+)/i);
    if (m) { const cat = 'bought ' + m[1].trim(); const r = A.logMoney(s, { kind: 'expense', amount: parseNum(m[2]), category: cat }); return reply(r.text, [{ kind: 'money', id: r.id }]); }

    // income words
    m = t.match(/(?:salary|came in|credited|received|got|earned|income)\s+(?:about\s+)?[₹$€£]?\s*([\d.,]+)/i);
    if (m) { const cat = /salary/.test(low) ? 'salary' : /(?:came in|credited|received)/.test(low) ? 'received' : 'income'; const r = A.logMoney(s, { kind: 'income', amount: parseNum(m[1]), category: cat }); return reply(r.text, [{ kind: 'money', id: r.id }]); }

    return null;
  }
  _monthTotals() {
    const s = this.store; const now = new Date(); let exp = 0, inc = 0;
    for (const mo of s.list('money')) if (mon(now) === mon(new Date(mo.date))) { if (mo.kind === 'income') inc += mo.amount; else exp += mo.amount; }
    return `out ${moneyToken(exp)} in ${moneyToken(inc)}`;
  }

  _tryStock(low, t) {
    const s = this.store;
    const isAdd = /\b(i|we|you)?\s*(have|got|have got|add(?:ed)?|bought|stock(?:ed)?|restocked|put)\b|there (is|are)/.test(low) && !/used/.test(low);
    const isUse = /\bused\b/.test(low) || /\bconsumed\b/.test(low) || /\bfinished\b/.test(low);
    if (!isAdd && !isUse) return null;
    const num = t.match(/(\d[\d.,]*)\s*(kg|kgs?|kilograms?|kilos?|kilo|grams?|g|millilitres?|ml|litres?|l|packets?|pieces?|bags?|bottles?|boxes?|scoops?|eggs?|loaves?|cans?|jars?|bars?)?/i);
    if (!num) return null;
    const qty = Math.abs(parseNum(num[1]));
    const unit = num[2] ? normUnit(num[2]) : null;
    // name = leftover words after removing number, unit and verbs
    let name = t.replace(/\d[\d.,]*/g, ' ')
      .replace(/(kg|kgs?|kilograms?|kilos?|kilo|grams?|g|millilitres?|ml|litres?|l|packets?|pieces?|bags?|bottles?|boxes?|scoops?|eggs?|loaves?|cans?|jars?|bars?)\b/gi, ' ')
      .replace(/\b(i|we|you|have|got|have got|had|add(ed)?|bought|stock(ed)?|restocked|used( up)?|of|about|the|a|an|at|now|there|is|are)\b/gi, ' ')
      .replace(/[.!?'"]/g, '').replace(/\s+/g, ' ').trim();
    if (!name && unit && /egg/i.test(num[2])) name = 'Eggs';
    if (!name) return isUse ? reply('Used how much of which item?') : null;
    const r = A.adjustStock(s, { name, delta: isUse ? -qty : qty, unit });
    return reply(r.text, [{ kind: 'stockItem', id: r.id }]);
  }

  _tryHealth(low, t) {
    const s = this.store;
    const medKw = /(paracetamol|panadol|aspirin|disprin|insulin|vitamin|tablet|pill|medicine|medication|dolo|ibuprofen|metformin|crocin|antibiotic|levo)/i;
    if (medKw.test(t) && /\b(took|had|taken|took my)\b/.test(low)) {
      const tm = timeFromText(t);
      const when = tm ? tm.label : '';
      const name = cleanName((t.match(/(?:took|had|taken)\s+(?:my\s+|a\s+|one\s+)?([a-z][a-z0-9\- ]*?)\s*(?:at\s+[\d:.]+(?:am|pm)?\s*)?$/i) || [])[1]) || 'Medicine';
      const rec = s.addSync('journal', { text: `Took ${name}` + (when ? ' at ' + when : ''), mood: '', date: new Date().toISOString() });
      return reply(`Logged ${name} taken${when ? ' at ' + when : ' today'}.`, [{ kind: 'journal', id: rec.id }]);
    }
    let m = t.match(/blood pressure\s*[:=]?\s*([\d]{2,3})\s*\/\s*([\d]{2,3})/i);
    if (m) { const v = `${m[1]}/${m[2]}`; const rec = s.addSync('journal', { text: `Blood pressure ${v}`, mood: '' }); return reply(`Logged BP ${v}.`, [{ kind: 'journal', id: rec.id }]); }
    m = t.match(/weight\s*(?:is|=)?\s*([\d.]+)\s*(kg|kgs?|kilos?)?/i);
    if (m) { const rec = s.addSync('journal', { text: `Weight ${m[1]} kg` }); return reply(`Logged weight ${m[1]} kg.`, [{ kind: 'journal', id: rec.id }]); }
    m = t.match(/slept\s+([\d.]+)\s*(hours?|hrs?)?/i);
    if (m) { const rec = s.addSync('journal', { text: `Slept ${m[1]} hours` }); return reply(`Logged sleep ${m[1]}h.`, [{ kind: 'journal', id: rec.id }]); }
    m = t.match(/(?:walked|took|did)\s+([\d,]{3,})\s*(?:steps?)?/i) || t.match(/([\d,]{3,})\s*steps?\b/i);
    if (m && /walk|step|pace/.test(low)) { const rec = s.addSync('journal', { text: `Walked ${parseNum(m[1])} steps` }); return reply(`Logged ${(+m[1].replace(/,/g, '')).toLocaleString()} steps.`, [{ kind: 'journal', id: rec.id }]); }
    return null;
  }

  _tryHabit(low, t) {
    const s = this.store;
    const H = 'yoga|exercise|workout|gym|meditation|reading|read|piano|guitar|coding|code|study|running|run|swimming|swim|push.?ups|journal|walk|stretching|writing|drawing';
    let m = t.match(new RegExp('(?:did|done|finished|completed|practiced|practised|did my|logged|went to|started)\\s+(?:my\\s+|the\\s+|daily\\s+|today\\s+)?(' + H + ')', 'i'));
    if (m) { const nm = m[1].toLowerCase() === 'read' ? 'Reading' : m[1]; const r = A.logHabit(s, nm); this.ctx.push('habit', r.id, nm); return reply(r.text, [{ kind: 'habit', id: r.id }]); }
    m = t.match(new RegExp('(' + H + ')\\s+(?:done|did|finished|completed|logged)', 'i'));
    if (m) { const nm = m[1].toLowerCase() === 'read' ? 'Reading' : m[1]; const r = A.logHabit(s, nm); return reply(r.text, [{ kind: 'habit', id: r.id }]); }
    m = t.match(/(?:read|studied)\s+([\d]+)\s+pages?\b/i);
    if (m) { const r = A.logHabit(s, 'Reading'); return reply(r.text, [{ kind: 'habit', id: r.id }]); }
    return null;
  }

  _tryJournal(low, t) {
    if (/^(feeling|i feel|i'm feeling|i am feeling|i felt|felt|today was|today i|had a great|grateful|i had|good day|bad day|slept)\b/i.test(low) && !/\b(weight|blood pressure|steps)\b/.test(low)) {
      const rec = this.store.addSync('journal', { text: t.replace(/[.!]+$/, ''), mood: moodOf(low) });
      return reply('Journal entry saved.', [{ kind: 'journal', id: rec.id }]);
    }
    return null;
  }
}

// helper functions
function cleanRemTitle(raw) {
  let s = String(raw || '').trim();
  const tail = [
    /\s+every\s+[\w\s]*$/i,
    /\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?$/i,
    /\s+(?:tonight|tomorrow|today|noon|midnight)$/i,
    /\s+this\s+(?:morning|afternoon|evening|weekend|week)$/i,
    /\s+next\s+(?:week|month|year|\w+day)$/i,
    /\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i,
    /\s+in\s+\d+\s+(?:min|minute|hour|day|week)s?$/i,
    /\s+(?:am|pm|a\.m\.|p\.m\.)$/i
  ];
  for (let i = 0; i < 5; i++) {
    let changed = false;
    for (const re of tail) { if (re.test(s)) { s = s.replace(re, ''); changed = true; } }
    if (!changed) break;
  }
  return cap(s.trim());
}
function low2(t){ return String(t||'').toLowerCase(); }
function cap(s){ return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function moneyToken(n){ return Math.round(Math.abs(n)).toLocaleString('en-IN'); }
function moodOf(low){ if(/(great|happy|amazing|fantastic|good day|wonderful)/.test(low))return 'happy'; if(/(sad|down|low|bad|awful|angry|upset)/.test(low))return 'down'; if(/(tired|exhausted)/.test(low))return 'tired'; if(/(stressed|anxious|worried)/.test(low))return 'stressed'; return ''; }
function normUnit(u){ if(!u) return 'unit'; const l=u.toLowerCase(); if(/kg|kilo/.test(l))return 'kg'; if(/g\b|gm|gram/.test(l))return 'g'; if(/ml/.test(l))return 'ml'; if(/litre|liter|^l$/.test(l))return 'L'; if(/packet/.test(l))return 'packet'; if(/piece/.test(l))return 'piece'; if(/bag/.test(l))return 'bag'; if(/bottle/.test(l))return 'bottle'; if(/box/.test(l))return 'box'; if(/egg/.test(l))return 'egg'; if(/scoop/.test(l))return 'scoop'; if(/can/.test(l))return 'can'; if(/jar/.test(l))return 'jar'; if(/bar/.test(l))return 'bar'; return 'unit'; }
// Stock match groups: [full, num, unit, innerUnit, name]. Name is the last group.

function splitDue(body){
  const pats=[/\s+(?:by|before|due)\s+/i,/\s+at\s+(?:noon|midnight|\d[\d:.]*(?:\s*(?:am|pm))?)/i,/\s+tomorrow\b/i,/\s+tonight\b/i,/\s+this\s+(?:weekend|week|evening|morning|afternoon)\b/i,/\s+next\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,/\s+next\s+(?:week|month|day)\b/i,/\s+in\s+\d+\s+(?:min|minute|hour|day|week)s?\b/i,/\s+(?:on|for)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i];
  let cut=-1; for(const p of pats){const m=p.exec(body); if(m&&(cut<0||m.index<cut))cut=m.index;}
  if(cut<0) return {title: body.trim(), due:''};
  return {title: body.slice(0,cut).trim().replace(/\s+(?:for|on|to)\s*$/i,''), due: body.slice(cut).trim()};
}

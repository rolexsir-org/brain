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

function reply(text, cards, run, actions) { return { text, cards: cards || [], run: run || null, actions: actions || [] }; }
function saveFailure(result, item = 'that item') {
  if (result && !result.error) return null;
  return reply(result && result.error ? result.error : `Couldn’t save ${item}. Your device storage may be full.`);
}

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
    if (this.ctx.pending && this.ctx.pending.kind === 'event_time') {
      if (!/^(remind me|add task|schedule|add event|create event|note|remember|spent|delete|show|what)/.test(low)) {
        return this._finishEvent(this.ctx.pending.params, t);
      }
    }

    // ---- A typed answer to an ambiguous external-action choice ----
    const pendingExternal = this._finishExternalChoice(low, t);
    if (pendingExternal) return pendingExternal;

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

  /** Find people by name, alias, number, email, relationship, or username. */
  _findPeople(token, onlyIds = null) {
    const query = normStr(token);
    const digits = String(token || '').replace(/\D/g, '');
    const email = String(token || '').trim().toLowerCase();
    if (!query && !digits) return [];
    const allowed = onlyIds ? new Set(onlyIds) : null;
    const exact = [];
    const partial = [];
    for (const person of this.store.list('person')) {
      if (!person || (allowed && !allowed.has(person.id))) continue;
      const aliases = Array.isArray(person.aliases) ? person.aliases : [];
      const values = [person.name, ...aliases, person.relationship, person.instagram].filter(Boolean);
      const personDigits = String(person.phone || '').replace(/\D/g, '');
      const personEmail = String(person.email || '').trim().toLowerCase();
      const exactMatch = values.some(value => normStr(value) === query)
        || (!!digits && digits.length >= 7 && personDigits === digits)
        || (!!email && personEmail === email);
      if (exactMatch) { exact.push(person); continue; }
      const haystack = values.map(normStr).join(' ');
      if ((query.length >= 2 && haystack.includes(query)) || (!!digits && digits.length >= 4 && personDigits.includes(digits)) || (!!email && personEmail.includes(email))) partial.push(person);
    }
    return [...exact, ...partial];
  }

  _actionForPerson(action, person, extras = {}) {
    const name = person.name || 'this person';
    const phone = person.phone || '';
    if (action === 'call') {
      if (!phone) return reply(`I know ${name}, but do not have a phone number for them.`);
      this.ctx.push('person', person.id, name);
      return reply(`Ready to call ${name}.`, [], { id: 'call', label: `📞 Call ${name}`, args: { number: phone } });
    }
    if (action === 'sms') {
      if (!phone) return reply(`I know ${name}, but do not have a phone number for them.`);
      this.ctx.push('person', person.id, name);
      return reply(`Your phone will open a message composer for ${name}.`, [], { id: 'sms', label: `💬 Text ${name}`, args: { number: phone, body: extras.body || '' } });
    }
    if (action === 'whatsapp') {
      if (!phone) return reply(`I know ${name}, but WhatsApp needs a phone number for a direct chat.`);
      this.ctx.push('person', person.id, name);
      const direct = phone.trim().startsWith('+') || !!this.store.settings.countryCode;
      return reply(direct ? `WhatsApp will open ${name}'s chat. Review and send there.` : `I can open WhatsApp’s share page, but this saved number has no country code. Choose a recipient there, or add a country code in Settings for a direct chat.`, [], {
        id: 'whatsapp', label: `🟢 WhatsApp ${name}`, args: { number: phone, text: extras.body || '', countryCode: this.store.settings.countryCode || '', allowShareFallback: true }
      });
    }
    if (action === 'email') {
      if (!person.email) return reply(`I know ${name}, but do not have an email address for them.`);
      this.ctx.push('person', person.id, name);
      return reply(`Your mail app will open a draft for ${name}.`, [], {
        id: 'email', label: `✉️ Email ${name}`, args: { email: person.email, subject: extras.subject || '', body: extras.body || '' }
      });
    }
    if (action === 'maps') {
      if (!person.address) return reply(`I know ${name}, but do not have an address for them.`);
      this.ctx.push('person', person.id, name);
      return reply(`Directions to ${name}'s saved address are ready.`, [], {
        id: 'maps', label: `📍 Navigate to ${name}`, args: { query: person.address, directions: true }
      });
    }
    if (action === 'instagram') {
      if (!person.instagram) return reply(`I know ${name}, but do not have their Instagram handle. Add it to their contact first.`);
      this.ctx.push('person', person.id, name);
      return reply(`Opening ${name}'s Instagram profile.`, [], {
        id: 'open', label: `📸 Open ${name}'s Instagram`, args: { url: `https://www.instagram.com/${String(person.instagram).replace(/^@/, '')}/` }
      });
    }
    return null;
  }

  _askExternalChoice(action, people, extras = {}) {
    const candidates = people.slice(0, 6);
    this.ctx.setPending('external_action', { action, candidateIds: candidates.map(person => person.id), extras }, 'Which person?');
    const choices = candidates.map(person => ({
      label: person.name || 'Unnamed contact',
      // Instagram is resolved as an `open` handoff; there is deliberately no
      // synthetic Instagram executor or browser-side automation.
      id: action === 'instagram' ? 'open' : action,
      clearPending: true,
      args: action === 'maps' ? { query: person.address, directions: true }
        : action === 'email' ? { email: person.email, subject: extras.subject || '', body: extras.body || '' }
          : action === 'call' || action === 'sms' || action === 'whatsapp' ? { number: person.phone, body: extras.body || '', text: extras.body || '', countryCode: this.store.settings.countryCode || '', ...(action === 'whatsapp' ? { allowShareFallback: true } : {}) }
            : { url: person.instagram ? `https://www.instagram.com/${String(person.instagram).replace(/^@/, '')}/` : '' }
    })).filter(choice => !!choice.args.number || !!choice.args.email || !!choice.args.query || !!choice.args.url);
    return reply(`Which ${candidates[0].name ? candidates[0].name.split(' ')[0] : 'person'}?`, candidates.map(person => ({ kind: 'person', id: person.id })), null, choices);
  }

  _finishExternalChoice(low, text) {
    const pending = this.ctx.pending;
    if (!pending || pending.kind !== 'external_action') return null;
    if (/^(cancel|never mind|nevermind|stop|no)\b/.test(low)) {
      this.ctx.clearPending();
      return reply('Okay, cancelled.');
    }
    const params = pending.params || {};
    const candidates = this._findPeople(text, params.candidateIds || []);
    let selected = null;
    const number = /^\s*(\d+)\s*$/.exec(text);
    if (number && params.candidateIds && params.candidateIds[+number[1] - 1]) selected = this.store.get('person', params.candidateIds[+number[1] - 1]);
    else if (candidates.length === 1) selected = candidates[0];
    if (selected) {
      this.ctx.clearPending();
      return this._actionForPerson(params.action, selected, params.extras || {});
    }
    // A new command should be allowed to supersede the question.
    if (/^(call|text|sms|message|whatsapp|email|mail|navigate|open|share|add|remind)\b/.test(low)) {
      this.ctx.clearPending();
      return null;
    }
    if (candidates.length > 1) return this._askExternalChoice(params.action, candidates, params.extras || {});
    return reply('Please choose one of the contacts shown, type their full name, or say “cancel”.');
  }

  _resolvePersonAction(action, target, extras = {}) {
    const directNumber = String(target || '').replace(/[^\d+]/g, '');
    if ((action === 'call' || action === 'sms' || action === 'whatsapp') && /^\+?\d{7,15}$/.test(directNumber)) {
      const labels = { call: '📞 Call', sms: '💬 Text', whatsapp: '🟢 WhatsApp' };
      const directWhatsApp = directNumber.startsWith('+') || !!this.store.settings.countryCode;
      const message = action === 'whatsapp'
        ? (directWhatsApp ? `WhatsApp will open a chat for ${directNumber}. Review and send there.` : 'WhatsApp’s share page will open. Choose a recipient there, or add a country code in Settings for a direct chat.')
        : action === 'call' ? `Ready to call ${directNumber}.` : `Your phone will open a message composer for ${directNumber}.`;
      return reply(message, [], {
        id: action, label: `${labels[action]} ${directNumber}`,
        args: { number: directNumber, body: extras.body || '', text: extras.body || '', countryCode: this.store.settings.countryCode || '', ...(action === 'whatsapp' ? { allowShareFallback: true } : {}) }
      });
    }
    const people = this._findPeople(target);
    if (people.length === 1) return this._actionForPerson(action, people[0], extras);
    if (people.length > 1) return this._askExternalChoice(action, people, extras);
    const noun = action === 'maps' ? 'saved address' : action === 'email' ? 'email address' : action === 'instagram' ? 'Instagram handle' : 'contact';
    return reply(`I could not find a ${noun} for “${target}”. Save the person in Brain first.`);
  }

  _lastRecord(preferred = null) {
    const ref = preferred ? this.ctx.last.find(item => item.type === preferred) : this.ctx.last[0];
    return ref ? { ref, record: this.store.get(ref.type, ref.id) } : { ref: null, record: null };
  }

  _lastDatedRecord() {
    for (const ref of this.ctx.last) {
      const record = this.store.get(ref.type, ref.id);
      if (record && (record.at || record.due)) return { ref, record };
    }
    return { ref: null, record: null };
  }

  /** Build an explicit system-share payload, preserving a local photo file when one exists. */
  _sharePayload(record) {
    if (!record) return { title: 'Brain', text: '' };
    const photoId = record.type === 'photo' ? record.id : record.type === 'journal' ? record.photoId : null;
    const title = record.title || record.name || (record.type === 'journal' ? 'Journal entry' : 'Brain');
    const text = record.type === 'photo' ? 'Photo from Brain' : (record.body || record.text || record.title || record.name || '');
    return { title, text, ...(photoId ? { photoId } : {}) };
  }

  _externalAction(low, text) {
    const store = this.store;
    let match;

    // Photos and contacts need a browser picker, so return a user-tappable action.
    if (/^(?:add|attach|choose|pick|upload)\b.*\b(?:photo|image|picture)\b/i.test(text)) {
      const attachTo = /\bjournal\b/i.test(text) ? 'journal' : '';
      return reply(attachTo ? 'Choose a photo to save with your journal.' : 'Choose a photo from this device.', [], {
        id: 'photoPick', label: '📷 Choose photo', args: { attachTo }
      });
    }
    if (/^(?:take|capture)\b.*\b(?:photo|picture|image)\b/i.test(text)) {
      const attachTo = /\bjournal\b/i.test(text) ? 'journal' : '';
      return reply('Open your camera to take a photo.', [], { id: 'cameraPick', label: '📸 Take photo', args: { attachTo } });
    }
    if (/^(?:import|pick|choose)\s+(?:my |device )?contacts?\b/i.test(text)) {
      return reply('Choose device contacts to copy into Brain. Brain cannot write to your system contacts.', [], { id: 'contactPick', label: '👤 Choose contacts', args: {} });
    }

    // Immediate phone actions. Scheduled wording falls through to a task/reminder.
    match = text.match(/^(?:call|ring|dial|phone)\s+(?:up\s+)?(.+?)\s*[?!.]?$/i);
    if (match && !/\b(?:tomorrow|today|tonight|at\s+\d|by\s+\d|next\s)\b/i.test(match[1])) return this._resolvePersonAction('call', match[1].trim());

    // WhatsApp has to be checked before generic "message".
    match = text.match(/^(?:whatsapp(?:\s+message)?|wa|message\s+(?:.+\s+)?on\s+whatsapp)\s+(.+)$/i);
    if (match) {
      const parsed = splitRecipientMessage(match[1], this._findPeople.bind(this));
      return this._resolvePersonAction('whatsapp', parsed.target, { body: parsed.message });
    }
    match = text.match(/^(?:text|sms|message)\s+(.+)$/i);
    if (match && !/\bon\s+whatsapp\b/i.test(match[1])) {
      const parsed = splitRecipientMessage(match[1], this._findPeople.bind(this));
      return this._resolvePersonAction('sms', parsed.target, { body: parsed.message });
    }

    match = text.match(/^(?:email|e-?mail|mail)\s+(.+)$/i);
    if (match) {
      const parsed = splitRecipientMessage(match[1], this._findPeople.bind(this));
      const target = parsed.target;
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) {
        return reply('Your mail app will open a draft. Sending remains your choice.', [], {
          id: 'email', label: '✉️ Email', args: { email: target, subject: parsed.message, body: parsed.message }
        });
      }
      return this._resolvePersonAction('email', target, { subject: parsed.message, body: parsed.message });
    }

    // Addresses are handed to Maps; no background location is claimed.
    match = text.match(/^(?:navigate|get directions|route|take me|go to)\s+(?:to\s+)?(.+)$/i);
    if (match) {
      let target = match[1].trim().replace(/[?!.]+$/, '').replace(/(?:['’]s\s+)?(?:house|home|place)$/i, '').trim();
      if (/^(?:my\s+)?(?:current\s+)?location$/i.test(target)) return reply('Brain can request your current location once, then open it in Maps.', [], { id: 'location.current', label: '📍 Open my location', args: {} });
      const people = this._findPeople(target);
      if (people.length || /\b(?:john|sarah|mom|dad)\b/i.test(target)) return this._resolvePersonAction('maps', target);
      return reply(`Directions to “${target}” are ready.`, [], { id: 'maps', label: `📍 Navigate`, args: { query: target, directions: true } });
    }
    match = text.match(/^(?:open|show)\s+(?:this\s+)?location\b/i);
    if (match) {
      const last = this._lastRecord();
      const record = last.record;
      const query = record && (record.address || record.location);
      if (query) return reply('Opening the saved location in Maps.', [], { id: 'maps', label: '📍 Open location', args: { query, directions: true } });
      return reply('I do not have a saved location in the current context. Say “navigate to 12 Market Road” or save an address on a person.');
    }
    match = text.match(/^(?:open|show)\s+(?:in\s+)?maps?\s+(?:for|to)?\s*(.+)$/i);
    if (match && match[1]) return reply('Opening Maps.', [], { id: 'maps', label: '📍 Open Maps', args: { query: match[1].trim(), directions: /directions|navigate/i.test(low) } });

    // A web page cannot publish or automate Instagram. Keep that limitation
    // distinct from both a legitimate profile open and the system share sheet.
    if (/(?:\b(?:automate|post|publish|upload)\b.*\b(?:to|on)?\s*(?:instagram|insta)\b|\b(?:instagram|insta)\b.*\b(?:automate|post|publish|upload)\b)/i.test(text)) {
      return reply('Brain cannot post to or automate Instagram from a browser. You can open a profile, or use Share to choose Instagram yourself when your device offers it.');
    }

    // A no-recipient WhatsApp handoff uses its official compose/share route.
    // Photos must use the system share sheet because wa.me cannot attach files.
    if (/^(?:share|send)\b.*\b(?:to|on|via)\s+(?:whatsapp|wa)\b/i.test(text)) {
      const last = this._lastRecord();
      const payload = this._sharePayload(last.record);
      const requested = text.replace(/^(?:share|send)\s*/i, '').replace(/\s+(?:to|on|via)\s+(?:whatsapp|wa)\b.*$/i, '').trim();
      if (!last.record && (!requested || /^(?:this|that|it)$/i.test(requested))) {
        return reply('I do not have an item to share yet. Save or show something first, then ask to share it.');
      }
      if (!last.record) payload.text = requested;
      if (payload.photoId) {
        return reply('Brain can open your system share sheet with the photo. Choose WhatsApp there if it is available; Brain cannot attach or send it through WhatsApp automatically.', [], {
          id: 'share', label: '🔗 Share photo with an app', args: payload
        });
      }
      if (!payload.text) return reply('I do not have shareable text for that item.');
      return reply('WhatsApp’s official share page will open. Choose a recipient and review before sending.', [], {
        id: 'whatsapp', label: '🟢 Open WhatsApp share', args: { number: '', text: payload.text }
      });
    }

    // Instagram only exposes navigation and the OS share sheet to a web app.
    if (/^(?:open|launch|go to)\s+(?:instagram|insta)\b/i.test(text)) {
      return reply('Opening Instagram.', [], { id: 'open', label: '📸 Open Instagram', args: { url: 'https://www.instagram.com/' } });
    }
    match = text.match(/^(?:open|visit|go to)\s+(.+?)(?:['’]s)?\s+(?:instagram|insta)\b/i);
    if (match) return this._resolvePersonAction('instagram', match[1].trim());
    if (/\b(?:share|send)\b.*\b(?:to|on)\s+(?:instagram|insta)\b/i.test(text)) {
      const last = this._lastRecord();
      const payload = this._sharePayload(last.record);
      const shareText = last.record ? payload.text : text.replace(/^.*?(?:share|send)\s+/i, '').replace(/\s+(?:to|on)\s+(?:instagram|insta).*$/i, '').trim();
      if (!last.record && (!shareText || /^(?:this|that|it)$/i.test(shareText))) {
        return reply('I do not have an item to share yet. Save or show something first, then ask to share it.');
      }
      if (!last.record) payload.text = shareText;
      return reply(payload.photoId
        ? 'Brain can open your system share sheet with the photo; choose Instagram there if it is offered. A browser cannot post to Instagram automatically.'
        : 'Brain can open your system share sheet; choose Instagram there if it is offered. A browser cannot post to Instagram automatically.', [], {
        id: 'share', label: payload.photoId ? '🔗 Share photo with an app' : '🔗 Share with an app', args: payload
      });
    }

    match = text.match(/^(?:open|visit|go to)\s+(https?:\/\/\S+)/i);
    if (match) return reply('Opening link.', [], { id: 'open', label: '🔗 Open link', args: { url: match[1].replace(/[)\]"'.,;]+$/, '') } });

    // Copy a stored value when named; plain text remains a real clipboard action.
    if (/^(?:copy)\b/i.test(text)) {
      const requested = text.replace(/^copy\s*/i, '').trim();
      const valueMatch = requested.match(/^(?:the\s+)?(phone|number|email|address)\s+(?:of|for)?\s*(.+)$/i);
      if (valueMatch) {
        const people = this._findPeople(valueMatch[2]);
        if (people.length === 1) {
          const field = valueMatch[1].toLowerCase();
          const value = field === 'email' ? people[0].email : field === 'address' ? people[0].address : people[0].phone;
          if (value) return reply(`Ready to copy ${people[0].name}'s ${field}.`, [], { id: 'copy', label: `📋 Copy ${field}`, args: { text: value } });
        }
      }
      if (requested) return reply('Ready to copy.', [], { id: 'copy', label: '📋 Copy', args: { text: requested } });
    }

    // Calendar files are a legitimate handoff, never a claim that an event was added.
    if (/\b(?:add|save)\b.*\bcalendar\b/i.test(text)) {
      const last = this._lastDatedRecord();
      const record = last.record;
      if (record && (record.at || record.due)) {
        const start = record.at || record.due;
        return reply(`A calendar file is ready for “${record.title || record.name}”. Open it and confirm the event in your calendar.`, [], {
          id: 'calendar', label: '📅 Add to calendar', args: {
            title: record.title || record.name || 'Brain item', start,
            end: record.end || new Date(new Date(start).getTime() + 3600000).toISOString(),
            allDay: !!record.allDay, location: record.location || record.address || '', description: record.notes || record.note || ''
          }
        });
      }
      return reply('Tell me which dated task, reminder, or event to add first. For example: “schedule dentist tomorrow at 3pm”, then “add that to my calendar”.');
    }

    if (/^(?:share|send)\b/i.test(text)) {
      const requested = text.replace(/^(?:share|send)\s*/i, '').trim();
      if (/today['’]?s (?:plan|schedule)|my schedule|today(?:\b|$)|plans?\b/i.test(requested)) {
        return reply('Here is today’s plan. The share sheet will let you choose an installed app.', [], { id: 'share', label: '🔗 Share plan', args: { title: 'Brain — Today’s plan', text: this._sharePlanText() } });
      }
      const preferred = /reminder/i.test(requested) ? 'reminder' : /note/i.test(requested) ? 'note' : /task/i.test(requested) ? 'task' : /event/i.test(requested) ? 'event' : null;
      const last = this._lastRecord(preferred);
      if (/^(?:this|the)?\s*(?:photo|image|note|reminder|task|event|journal)?\s*$/i.test(requested) && last.record) {
        const payload = this._sharePayload(last.record);
        return reply(payload.photoId
          ? 'Ready to open your system share sheet with this local photo.'
          : 'Ready to open your system share sheet.', [], {
          id: 'share', label: payload.photoId ? '🔗 Share photo' : '🔗 Share', args: payload
        });
      }
      const people = this._findPeople(requested);
      if (people.length === 1) {
        const person = people[0];
        return reply('Ready to share this contact through your system share sheet.', [], { id: 'share', label: '🔗 Share contact', args: { title: person.name, text: [person.name, person.phone, person.email, person.address].filter(Boolean).join('\n') } });
      }
      if (requested) return reply('Ready to open your system share sheet.', [], { id: 'share', label: '🔗 Share', args: { title: 'Brain', text: requested } });
    }

    return null;
  }

  /** Build a plain-text summary of today (reminders, tasks, events, low stock). */
  _sharePlanText() {
    const s = this.store; const day = todayKey(); const lines = [];
    const due = s.list('task').filter(x => x.status !== 'done' && x.due && todayKey(new Date(x.due)) === day);
    if (due.length) lines.push('Tasks: ' + due.map(x => x.title).join(', '));
    for (const e of s.list('event')) if (e.at && todayKey(new Date(e.at)) === day) lines.push('📅 ' + e.title);
    const now = new Date();
    const rems = s.list('reminder').filter(r => r.status === 'active' && (
      (r.at && todayKey(new Date(r.at)) === day)
      || (r.recur && D.recurrenceMatches(r.recur, now, r.recur.anchor || r.createdAt))
    ));
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
    const listKinds = { reminders: 'reminder', tasks: 'task', notes: 'note', contacts: 'person', people: 'person', photos: 'photo', pictures: 'photo', stock: 'stockItem', events: 'event', habits: 'habit', journal: 'journal' };
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

    // Phone/email/address lookup returns an actionable contact card rather than dead text.
    m = t.match(/(?:what'?s|what is|give me|show)\s+(?:the\s+)?(?:phone\s+)?(?:number|phone|mobile|email|address)\s+(?:of|for)?\s*([a-z0-9 .'-]+?)\s*\??$/i) ||
        t.match(/([a-z0-9 .'-]+?)(?:'s)?\s+(?:phone|number|mobile|email|address)\s*\??$/i);
    if (m) {
      const people = this._findPeople(m[1]);
      if (people.length === 1) {
        const person = people[0];
        this.ctx.push('person', person.id, person.name);
        return reply(`${person.name}:`, [{ kind: 'person', id: person.id }]);
      }
      if (people.length > 1) return this._askExternalChoice('call', people);
      return reply(`I could not find a saved person matching “${m[1]}”.`);
    }
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
    // Only show reminders with an occurrence in this horizon. Listing every
    // recurring rule makes “what's coming up?” misleading for weekly/monthly
    // rules that do not occur soon.
    const rems = s.list('reminder').filter(reminder => {
      if (reminder.status === 'done') return false;
      if (reminder.snoozedUntil) return new Date(reminder.snoozedUntil) <= end;
      if (reminder.recur) {
        const next = D.nextOccurrence(reminder.recur, new Date(now.getTime() - 1000));
        return !!next && next <= end;
      }
      return !!reminder.at && new Date(reminder.at) <= end;
    });
    for (const reminder of rems.slice(0, 8)) { cards.push({ kind: 'reminder', id: reminder.id }); }
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
      if (last.type === 'money') {
        const value = parseNum(amtM[1]);
        const updated = s.updateSync('money', last.id, { amount: Math.abs(value) });
        if (!updated) return saveFailure(null, 'that money record');
        this.ctx.push('money', last.id, 'money'); return reply(`Updated to ${moneyToken(value)}.`);
      }
    }
    // "mark it done" / "complete it" / "done" (last)
    if (/\b(mark|mark it|mark that)\s+(done|complete)\b|(?:^| )(done|complete|finish it|finish that)\b/.test(low) && last) {
      if (last.type === 'task') {
        const completed = A.completeTask(s, last.id);
        return saveFailure(completed, 'that task') || reply(completed.text);
      }
      if (last.type === 'reminder') {
        const completed = A.completeReminder(s, last.id);
        return saveFailure(completed, 'that reminder') || reply(completed.text);
      }
    }
    // "reopen / uncomplete" last task
    if (/\b(reopen|uncomplete|undo|open again)\b/.test(low) && last && last.type === 'task') {
      const reopened = A.reopenTask(s, last.id);
      return saveFailure(reopened, 'that task') || reply(reopened.text);
    }
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
    const label = this._label(target);
    const removed = s.removeSync(target.type, target.id);
    this.ctx.clearPending();
    if (!removed) return reply('That item is no longer available.');
    this.ctx.last = this.ctx.last.filter(item => !(item.type === target.type && item.id === target.id));
    return reply(`Deleted ${label}.`);
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
    if (wake) {
      const time = timeFromText(wake[1]);
      if (time) {
        const at = new Date(now); at.setHours(time.h, time.min, 0, 0);
        if (at <= now) at.setDate(at.getDate() + 1);
        const r = A.createReminder(s, { title: 'Wake up', at });
        const failed = saveFailure(r, 'that reminder'); if (failed) return failed;
        this.ctx.push('reminder', r.id, 'Wake up');
        return reply(r.text, [{ kind: 'reminder', id: r.id }]);
      }
      return this._askReminderTime('Wake up');
    }

    // ---- REMINDERS ----
    if (/\bremind me\b/.test(low) || /remind me to|set (a )?reminder|don'?t let me forget/.test(low)) {
      let m = t.match(/\bremind me\s+(?:to|that|about)\s+(.+?)\s*$/i);
      const title = m ? cleanRemTitle(m[1]) : cleanRemTitle(t.replace(/\bremind me\b|set (a )?reminder/i, '').replace(/\bto\s*/i, ''));
      if (!title) return reply('Remind you to do what?');
      return this._addReminder(title, t);
    }

    // ---- EVENTS (before tasks: "schedule a meeting" is an event) ----
    const eventRes = this._tryEvent(low, t);
    if (eventRes) return eventRes;

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
      const failed = saveFailure(r, 'that reminder');
      if (failed) return failed;
      this.ctx.push('reminder', r.id, title);
      return reply(r.text, [{ kind: 'reminder', id: r.id }]);
    }
    // one-off
    const res = resolveMoment(fullText, now);
    if (res.matched && (res.hasTime || /tomorrow|tonight|today|[a-z]day|weekend|week|month|march|jan|feb|apr|may|jun|jul|aug|sep|oct|nov|dec|in \d+|\/|-/i.test(fullText))) {
      // has a day/date or a clock
      if (!res.hasTime && !/morning|afternoon|evening|tonight|noon|midnight/.test(low2(fullText))) return this._askReminderTime(title, null, res.date);
      if (res.date <= now) return reply('That reminder time has already passed. Choose a future time, such as “tomorrow at 7pm”.');
      const r = A.createReminder(s, { title, at: res.date });
      const failed = saveFailure(r, 'that reminder');
      if (failed) return failed;
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
    if (/^(?:cancel|skip|never mind|nevermind|stop)\b/i.test(String(whenText || '').trim())) {
      this.ctx.clearPending();
      return reply('Okay, I did not save that reminder.');
    }
    const recur = parseRecur('every ' + whenText, now) || params.recur;
    if (recur) {
      let time = recur.time || D.clockString(whenText) || '09:00';
      const rr = Object.assign({}, recur, { time });
      const r = A.createReminder(s, { title: params.title, recur: rr });
      const failed = saveFailure(r, 'that reminder');
      if (failed) return failed;
      this.ctx.clearPending(); this.ctx.push('reminder', r.id, params.title);
      return reply(r.text, [{ kind: 'reminder', id: r.id }]);
    }
    const res = resolveMoment(whenText, now);
    if (!res.matched) return reply('I didn’t get that as a time. Try again, or say “skip”.');
    // A follow-up such as “7pm” supplies the missing clock, not a replacement
    // for the date we already understood from “remind me … tomorrow”.
    const suppliedClock = D.timeFromText(whenText) || D.implicitTime(whenText);
    const suppliedDate = D.dateWordFromText(whenText, now).matched || D.relativeFromText(whenText, now).matched;
    if (params.atHint && suppliedClock && !suppliedDate) {
      const hinted = new Date(params.atHint);
      if (!Number.isNaN(hinted.getTime())) {
        hinted.setHours(suppliedClock.h, suppliedClock.min, 0, 0);
        res.date = hinted;
      }
    }
    if (res.date <= now) return reply('That reminder time has already passed. Try a future time, or say “skip”.');
    const r = A.createReminder(s, { title: params.title, at: res.date });
    const failed = saveFailure(r, 'that reminder');
    if (failed) return failed;
    this.ctx.clearPending(); this.ctx.push('reminder', r.id, params.title);
    return reply(r.text, [{ kind: 'reminder', id: r.id }]);
  }

  _tryEvent(low, t) {
    if (/\bremind me\b/.test(low)) return null;
    const eventWords = /\b(?:event|appointment|meeting|dentist|doctor|flight|trip|concert|class|exam|interview|reservation)\b/i;
    const explicit = /^(?:add|create|schedule|book|set)\s+(?:an?\s+)?(?:event|appointment|meeting|dentist|doctor|flight|trip|concert|class|exam|interview|reservation)\b/i;
    if (!eventWords.test(t) || (!explicit.test(t) && !/\b(?:on|tomorrow|today|next|at)\b/i.test(t))) return null;
    const now = new Date();
    const resolved = resolveMoment(t, now);
    const title = cleanEventTitle(t);
    if (!title) return reply('What event should I add?');
    const location = eventLocationFromText(t);
    const notes = eventNotesFromText(t);
    const kindMatch = t.match(/\b(event|appointment|meeting|dentist|doctor|flight|trip|concert|class|exam|interview|reservation)\b/i);
    const kind = kindMatch ? kindMatch[1].toLowerCase() : 'event';
    if (!resolved.matched) {
      this.ctx.setPending('event_time', { title, location, notes, kind }, 'When is it?');
      return reply(`When is “${title}”? (for example, tomorrow at 3pm)`);
    }
    const allDay = !resolved.hasTime;
    const end = allDay ? new Date(resolved.date.getTime() + 86400000) : new Date(resolved.date.getTime() + 60 * 60 * 1000);
    const result = A.createEvent(this.store, { title, at: resolved.date, end, allDay, kind, location, notes });
    if (result.error) return reply(result.error);
    this.ctx.push('event', result.id, title);
    return reply(result.text, [{ kind: 'event', id: result.id }]);
  }

  _finishEvent(params, whenText) {
    if (/^(?:cancel|skip|never mind|nevermind|stop)\b/i.test(String(whenText || '').trim())) {
      this.ctx.clearPending();
      return reply('Okay, I did not save that event.');
    }
    const resolved = resolveMoment(whenText, new Date());
    if (!resolved.matched) return reply('I did not understand that date or time. Try “tomorrow at 3pm” or say “cancel”.');
    const allDay = !resolved.hasTime;
    const end = allDay ? new Date(resolved.date.getTime() + 86400000) : new Date(resolved.date.getTime() + 60 * 60 * 1000);
    const result = A.createEvent(this.store, { ...params, at: resolved.date, end, allDay });
    const failed = saveFailure(result, 'that event');
    if (failed) return failed;
    this.ctx.clearPending();
    this.ctx.push('event', result.id, params.title);
    return reply(result.text, [{ kind: 'event', id: result.id }]);
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
    // split trailing due phrase and preserve a recurrence as a real recurrence.
    const parts = splitDue(body);
    const recurrence = parseRecur(body, now);
    const title = cap(cleanTaskTitle(parts.title, recurrence));
    let due = null; let dueTxt = '';
    if (recurrence) {
      due = D.nextOccurrence(recurrence, now);
      dueTxt = due;
    } else if (parts.due) {
      const res = resolveMoment(parts.due, now);
      if (res.matched && (res.hasTime || /tomorrow|today|tonight|[a-z]day|weekend|week|month|in \d+|\/|\d/.test(parts.due))) { due = res.date; dueTxt = res.date; }
    }
    const r = A.createTask(s, { title, due, recur: recurrence });
    if (r.error) return reply(r.error);
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
      const failed = saveFailure(r, 'that note'); if (failed) return failed;
      this.ctx.push('note', r.id, r.rec.title || 'note');
      return reply(r.text, [{ kind: 'note', id: r.id }]);
    }
    // wifi password
    m = t.match(/(?:wifi|wi-?fi)\s*(?:password|pass|key)?\s*(?:is|=|:)?\s*[:,-]?\s*([\w@#$%^&*!.\-]{4,})/i);
    if (m && /wifi/.test(low)) {
      const r = A.saveNote(s, { title: 'WiFi password', body: m[1], isPrivate: true });
      const failed = saveFailure(r, 'that note'); if (failed) return failed;
      this.ctx.push('note', r.id, 'WiFi password'); return reply('Saved 🔒', [{ kind: 'note', id: r.id }]);
    }
    // recipe/address specifics
    m = t.match(/recipe\s*:?\s*(.+)$/i);
    if (m && /recipe/.test(low)) {
      const r = A.saveNote(s, { title: 'Recipe', body: m[1].trim(), tags: ['recipe'] });
      const failed = saveFailure(r, 'that note'); if (failed) return failed;
      this.ctx.push('note', r.id, r.rec.title || 'Recipe');
      return reply(r.text, [{ kind: 'note', id: r.id }]);
    }
    m = t.match(/(?:parking spot|parking)\s+(?:is|=)\s+(.+)/i);
    if (m) {
      const r = A.saveNote(s, { title: 'Parking spot', body: m[1].trim() });
      const failed = saveFailure(r, 'that note'); if (failed) return failed;
      this.ctx.push('note', r.id, r.rec.title || 'Parking spot');
      return reply(r.text, [{ kind: 'note', id: r.id }]);
    }
    return null;
  }

  _tryPerson(low, t) {
    const s = this.store;
    // Instagram handle. This only stores a handle; opening it later uses the
    // public profile URL and never claims Instagram automation.
    let m = t.match(/([a-z][a-z .'-]+?)(?:['’]s)?\s+(?:instagram|insta)(?:\s+(?:handle|username))?\s*(?:is|=|:)\s*@?([a-z0-9._]{1,30})\b/i);
    if (m) {
      const name = cleanName(m[1]);
      const person = this._ensurePerson(name);
      if (!person) return saveFailure(null, 'that person');
      const updated = s.updateSync('person', person.id, { instagram: m[2] });
      if (!updated) return saveFailure(null, 'that person');
      this.ctx.push('person', updated.id, updated.name);
      return reply(`Saved ${updated.name}'s Instagram handle.`, [{ kind: 'person', id: updated.id }]);
    }
    // Aliases make later "call Johnny" resolution deterministic.
    m = t.match(/([a-z][a-z .'-]+?)(?:['’]s)?\s+(?:alias|nickname|also known as)\s*(?:is|=|:)?\s*([a-z][a-z .'-]+)\s*$/i);
    if (m) {
      const name = cleanName(m[1]);
      const alias = cleanName(m[2]);
      const person = this._ensurePerson(name);
      if (!person) return saveFailure(null, 'that person');
      const aliases = [...new Set([...(person.aliases || []), alias])];
      const updated = s.updateSync('person', person.id, { aliases });
      if (!updated) return saveFailure(null, 'that person');
      this.ctx.push('person', updated.id, updated.name);
      return reply(`Saved ${alias} as an alias for ${updated.name}.`, [{ kind: 'person', id: updated.id }]);
    }
    // birthday
    m = t.match(/([a-z][a-z ]+?)(?:'s|')?\s+birthday\s+(?:is|on|falls on)?\s+(.+?)\s*$/i);
    if (m && /birthday/.test(low)) {
      const name = cleanName(m[1].replace(/'s$/i, ''));
      const bdRaw = m[2].trim();
      if (/^(me|my|mine)$/i.test(name)) return this._addMyBirthday(bdRaw);
      if (this._isCommon(name)) return null;
      let p = this._ensurePerson(name);
      if (!p) return saveFailure(null, 'that person');
      p = s.updateSync('person', p.id, { birthday: bdRaw });
      if (!p) return saveFailure(null, 'that person');
      this.ctx.push('person', p.id, name);
      return reply(`Saved: ${name}'s birthday ${bdRaw}.`, [{ kind: 'person', id: p.id }]);
    }
    // phone number detail
    m = t.match(/([a-z][a-z ]+?)(?:'s)?\s+(?:phone|number|mobile|contact)\s*(?:number)?\s*(?:is|=)\s*([+\d][\d\s-]{6,})/i);
    if (m) {
      const name = cleanName(m[1]); const num = m[2].replace(/\s/g, '');
      const person = this._ensurePerson(name); if (!person) return saveFailure(null, 'that person');
      const p = s.updateSync('person', person.id, { phone: num }); if (!p) return saveFailure(null, 'that person');
      this.ctx.push('person', p.id, name); return reply(`Saved ${name}'s number ${num}.`, [{ kind: 'person', id: p.id }]);
    }
    // add contact explicit
    m = t.match(/(?:add|save|new)\s+contact\s*[:,-]?\s*([a-z][a-z ]+?)(?:\s*,\s*([+\d][\d\s-]{6,}))?/i);
    if (m && /contact/.test(low)) {
      const name = cleanName(m[1]); const person = this._ensurePerson(name); if (!person) return saveFailure(null, 'that person');
      const p = m[2] ? s.updateSync('person', person.id, { phone: m[2].replace(/\s/g, '') }) : person;
      if (!p) return saveFailure(null, 'that person');
      this.ctx.push('person', p.id, name); return reply(`Saved contact ${p.name}.`, [{ kind: 'person', id: p.id }]);
    }
    // email
    m = t.match(/([a-z][a-z .'-]+?)(?:'s)?\s+email\s*(?:address\s*)?(?:is|is at)?\s*([\w.+-]+@[\w-]+\.[\w.]+)/i);
    if (m && /email/.test(low) && !/^(call|text|message|whatsapp|share)\b/.test(low)) {
      const name = cleanName(m[1].replace(/'s$/i, '')); if (this._isCommon(name)) return null;
      const em = m[2].toLowerCase(); const person = this._ensurePerson(name);
      if (!person) return saveFailure(null, 'that person');
      const p = s.updateSync('person', person.id, { email: em }); if (!p) return saveFailure(null, 'that person');
      this.ctx.push('person', p.id, name);
      return reply(`Saved ${name}'s email ${em}.`, [{ kind: 'person', id: p.id }]);
    }
    // address / lives at
    m = t.match(/([a-z][a-z .'-]+?)\s+(?:lives at|address is|address:|home is|works at|place is)\s+(.+?)\s*$/i);
    if (m && /lives at|address|home is|works at|place is/i.test(low)) {
      const name = cleanName(m[1]); if (this._isCommon(name)) return null;
      const addr = m[2].replace(/[.!]+$/, '').trim(); const person = this._ensurePerson(name);
      if (!person) return saveFailure(null, 'that person');
      const p = s.updateSync('person', person.id, { address: addr }); if (!p) return saveFailure(null, 'that person');
      this.ctx.push('person', p.id, name);
      return reply(`Saved ${name}'s address.`, [{ kind: 'person', id: p.id }]);
    }
    // misc person fact "X is allergic..." -> needs a known person; skip if ambiguous
    return null;
  }
  _addMyBirthday(bdRaw) {
    const at = A.nextBirthdayFor(bdRaw);
    if (!at) return reply('I did not understand that birthday date. Try “March 12”.');
    const e = A.createEvent(this.store, { title: (this.name || 'Your') + ' birthday', at, allDay: true, kind: 'birthday' });
    return saveFailure(e, 'that event') || reply(e.text, [{ kind: 'event', id: e.id }]);
  }
  _isCommon(n) { return /^(mom|dad|mum|mother|father|brother|sister|grandma|grandpa|friend|doctor|teacher|the|a|my|your)$/i.test(n); }
  _ensurePerson(name) {
    const s = this.store;
    let p = s.list('person').find(x => x.name.toLowerCase() === name.toLowerCase());
    if (!p) { p = s.addSync('person', { name }); }
    return p;
  }

  _tryMoney(low, t) {
    const s = this.store;
    const saveDebt = (name, amount, dir) => {
      // Ensure a referenced person can be represented before recording a debt;
      // never claim a debt was recorded if its required contact failed.
      if (!this._ensurePerson(name)) return saveFailure(null, 'that person');
      const record = A.logDebt(s, { person: name, amount, dir });
      const failed = saveFailure(record, 'that debt');
      if (failed) return failed;
      this.ctx.push('debt', record.id, name);
      return reply(record.text, [{ kind: 'debt', id: record.id }]);
    };
    const saveMoney = (kind, amount, category, { context = true, monthTotal = false } = {}) => {
      const record = A.logMoney(s, { kind, amount, category });
      const failed = saveFailure(record, 'that money record');
      if (failed) return failed;
      if (context) this.ctx.push('money', record.id, category);
      return reply(record.text + (monthTotal ? ` (this month: ${this._monthTotals()})` : ''), [{ kind: 'money', id: record.id }]);
    };

    // Repayment settles an open debt when one exists; otherwise it is income.
    let m = t.match(/([a-z][a-z ]+?)\s+(?:paid\s+me(?: back)?|repaid|paid back)\s+([₹$€£]?\s*[\d.,]+)/i);
    if (m) {
      const name = cleanName(m[1]);
      const debt = s.list('debt').find(record => record.dir === 'they_owe_me' && record.status !== 'settled' && record.person.toLowerCase() === name.toLowerCase());
      if (debt) {
        const settled = A.settleDebt(s, debt.id);
        return saveFailure(settled, 'that debt') || reply(`Recorded: ${name} repaid you.`);
      }
      const value = parseNum(m[2]);
      return saveMoney('income', value, `repayment from ${name}`);
    }

    // "X owes me Y"
    m = t.match(/([a-z][a-z ]+?)\s+owes\s+me\s+[₹$€£]?\s*([\d.,]+)/i);
    if (m) {
      const name = cleanName(m[1]);
      if (!this._isCommon(name)) return saveDebt(name, parseNum(m[2]), 'they_owe_me');
    }
    // "I owe X Y"
    m = t.match(/\bi owe\s+([a-z][a-z ]+?)\s+[₹$€£]?\s*([\d.,]+)/i);
    if (m) return saveDebt(cleanName(m[1]), parseNum(m[2]), 'i_owe_them');
    // "lent X Y" (I lent) -> they owe me; "X lent me Y" -> I owe X
    m = t.match(/([a-z][a-z ]+?)\s+lent\s+me\s+[₹$€£]?\s*([\d.,]+)/i);
    if (m) return saveDebt(cleanName(m[1]), parseNum(m[2]), 'i_owe_them');
    m = t.match(/(?:i\s+|)lent\s+([a-z][a-z ]+?)\s+[₹$€£]?\s*([\d.,]+)/i);
    if (m && !/\bme\b/.test(m[0])) return saveDebt(cleanName(m[1]), parseNum(m[2]), 'they_owe_me');

    // Expenses
    m = t.match(/(?:spen[dt]|spending)\s+(?:about\s+)?[₹$€£]?\s*([\d.,]+)\s*(?:on|for|at)\s*(.+?)\s*$/i);
    if (m) return saveMoney('expense', parseNum(m[1]), m[2].trim().replace(/[.!]/g, ''), { context: true, monthTotal: true });
    m = t.match(/(?:spen[dt]|spending)\s+(?:about\s+)?[₹$€£]?\s*([\d.,]+)/i);
    if (m) return saveMoney('expense', parseNum(m[1]), 'expense', { context: true, monthTotal: true });
    // "paid 300 for groceries" is an expense.
    m = t.match(/(?:paid|pays?)\s+[₹$€£]?\s*([\d.,]+)\s+(?:for\s+)?(.+?)\s*$/i);
    if (m) return saveMoney('expense', parseNum(m[1]), m[2].trim().replace(/[.!]/g, ''));
    // Bought X for Y (expense); stock tracking has its own command path too.
    m = t.match(/\bbought\s+(.+?)\s+for\s+[₹$€£]?\s*([\d.,]+)/i);
    if (m) return saveMoney('expense', parseNum(m[2]), `bought ${m[1].trim()}`);

    // Income words
    m = t.match(/(?:salary|came in|credited|received|got|earned|income)\s+(?:about\s+)?[₹$€£]?\s*([\d.,]+)/i);
    if (m) {
      const category = /salary/.test(low) ? 'salary' : /(?:came in|credited|received)/.test(low) ? 'received' : 'income';
      return saveMoney('income', parseNum(m[1]), category);
    }

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
    return saveFailure(r, 'that stock item') || reply(r.text, [{ kind: 'stockItem', id: r.id }]);
  }

  _tryHealth(low, t) {
    const s = this.store;
    const saveHealth = (text, confirmation) => {
      const record = A.logJournal(s, text, '');
      const failed = saveFailure(record, 'that journal entry'); if (failed) return failed;
      this.ctx.push('journal', record.id, 'journal entry');
      return reply(confirmation, [{ kind: 'journal', id: record.id }]);
    };
    const medKw = /(paracetamol|panadol|aspirin|disprin|insulin|vitamin|tablet|pill|medicine|medication|dolo|ibuprofen|metformin|crocin|antibiotic|levo)/i;
    if (medKw.test(t) && /\b(took|had|taken|took my)\b/.test(low)) {
      const tm = timeFromText(t);
      const when = tm ? tm.label : '';
      const name = cleanName((t.match(/(?:took|had|taken)\s+(?:my\s+|a\s+|one\s+)?([a-z][a-z0-9\- ]*?)\s*(?:at\s+[\d:.]+(?:am|pm)?\s*)?$/i) || [])[1]) || 'Medicine';
      return saveHealth(`Took ${name}${when ? ` at ${when}` : ''}`, `Logged ${name} taken${when ? ` at ${when}` : ' today'}.`);
    }
    let m = t.match(/blood pressure\s*[:=]?\s*([\d]{2,3})\s*\/\s*([\d]{2,3})/i);
    if (m) {
      const value = `${m[1]}/${m[2]}`;
      return saveHealth(`Blood pressure ${value}`, `Logged BP ${value}.`);
    }
    m = t.match(/weight\s*(?:is|=)?\s*([\d.]+)\s*(kg|kgs?|kilos?)?/i);
    if (m) return saveHealth(`Weight ${m[1]} kg`, `Logged weight ${m[1]} kg.`);
    m = t.match(/slept\s+([\d.]+)\s*(hours?|hrs?)?/i);
    if (m) return saveHealth(`Slept ${m[1]} hours`, `Logged sleep ${m[1]}h.`);
    m = t.match(/(?:walked|took|did)\s+([\d,]{3,})\s*(?:steps?)?/i) || t.match(/([\d,]{3,})\s*steps?\b/i);
    if (m && /walk|step|pace/.test(low)) {
      const steps = parseNum(m[1]);
      return saveHealth(`Walked ${steps} steps`, `Logged ${(+m[1].replace(/,/g, '')).toLocaleString()} steps.`);
    }
    return null;
  }

  _tryHabit(low, t) {
    const s = this.store;
    const H = 'yoga|exercise|workout|gym|meditation|reading|read|piano|guitar|coding|code|study|running|run|swimming|swim|push.?ups|journal|walk|stretching|writing|drawing';
    let m = t.match(new RegExp('(?:did|done|finished|completed|practiced|practised|did my|logged|went to|started)\\s+(?:my\\s+|the\\s+|daily\\s+|today\\s+)?(' + H + ')', 'i'));
    if (m) {
      const name = m[1].toLowerCase() === 'read' ? 'Reading' : m[1]; const r = A.logHabit(s, name);
      const failed = saveFailure(r, 'that habit'); if (failed) return failed;
      this.ctx.push('habit', r.id, name); return reply(r.text, [{ kind: 'habit', id: r.id }]);
    }
    m = t.match(new RegExp('(' + H + ')\\s+(?:done|did|finished|completed|logged)', 'i'));
    if (m) {
      const name = m[1].toLowerCase() === 'read' ? 'Reading' : m[1]; const r = A.logHabit(s, name);
      const failed = saveFailure(r, 'that habit'); if (failed) return failed;
      this.ctx.push('habit', r.id, name); return reply(r.text, [{ kind: 'habit', id: r.id }]);
    }
    m = t.match(/(?:read|studied)\s+([\d]+)\s+pages?\b/i);
    if (m) {
      const r = A.logHabit(s, 'Reading');
      const failed = saveFailure(r, 'that habit'); if (failed) return failed;
      this.ctx.push('habit', r.id, 'Reading'); return reply(r.text, [{ kind: 'habit', id: r.id }]);
    }
    return null;
  }

  _tryJournal(low, t) {
    if (/^(feeling|i feel|i'm feeling|i am feeling|i felt|felt|today was|today i|had a great|grateful|i had|good day|bad day|slept)\b/i.test(low) && !/\b(weight|blood pressure|steps)\b/.test(low)) {
      const record = A.logJournal(this.store, t.replace(/[.!]+$/, ''), moodOf(low));
      return saveFailure(record, 'that journal entry') || reply('Journal entry saved.', [{ kind: 'journal', id: record.id }]);
    }
    return null;
  }
}

// Parse "John “I’ll be there”", "John: hello", or a known contact prefix.
// This is intentionally deterministic: if a recipient cannot be identified, all
// remaining text is treated as the recipient instead of silently sending it wrong.
function splitRecipientMessage(raw, findPeople) {
  const input = String(raw || '').trim().replace(/[?!.]+$/, '');
  if (!input) return { target: '', message: '' };
  let match = input.match(/^(.+?)\s*(?:[:]|\b(?:saying|that|with message)\b)\s*[“"'](.+?)[”"']\s*$/i)
    || input.match(/^(.+?)\s*(?:[:]|\b(?:saying|that|with message)\b)\s*(.+)$/i)
    || input.match(/^(.+?)\s+[“"'](.+?)[”"']\s*$/);
  if (match) return { target: match[1].trim(), message: String(match[2] || '').trim() };

  // Email addresses and phone numbers are unambiguous enough to split at the
  // first whitespace following the address/number.
  match = input.match(/^([^\s@]+@[^\s@]+\.[^\s@]+)(?:\s+(.+))?$/i)
    || input.match(/^(\+?\d[\d\s().-]{6,})(?:\s+(.+))?$/);
  if (match) return { target: match[1].trim(), message: String(match[2] || '').trim() };

  const words = input.split(/\s+/);
  for (let length = words.length; length >= 1; length -= 1) {
    const candidate = words.slice(0, length).join(' ');
    const people = findPeople(candidate);
    // Require an exact/strong name-ish match for splitting; a fuzzy partial
    // should remain a clarification rather than losing part of the message.
    if (people.length === 1) {
      const person = people[0];
      const names = [person.name, ...(Array.isArray(person.aliases) ? person.aliases : [])].map(value => normStr(value));
      if (names.includes(normStr(candidate))) return { target: candidate, message: words.slice(length).join(' ').replace(/^(?:about|re:)\s*/i, '').trim() };
    }
  }
  return { target: input, message: '' };
}

function cleanTaskTitle(value, recurrence) {
  let title = String(value || '');
  if (recurrence) {
    title = title.replace(/\s+(?:every|each)\s+.+$/i, '');
    title = title.replace(/\s+(?:daily|weekly|monthly|yearly)\b.*$/i, '');
  }
  return title.trim() || 'Task';
}

function cleanEventTitle(value) {
  let title = String(value || '')
    .replace(/^(?:add|create|schedule|book|set)\s+(?:an?\s+)?/i, '')
    .replace(/\s+(?:on\s+)?\d{4}-\d{1,2}-\d{1,2}\b.*$/i, '')
    .replace(/\s+(?:on\s+)?\d{1,2}[/.\-]\d{1,2}(?:[/.\-]\d{2,4})?\b.*$/i, '')
    .replace(/\s+(?:on\s+)?(?:tomorrow|today|tonight|day after tomorrow|next\s+\w+|this\s+\w+)\b.*$/i, '')
    .replace(/\s+(?:on\s+)?(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}.*$/i, '')
    .replace(/\s+(?:at|by)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b.*$/i, '')
    .replace(/[—–-]\s*(?:note|notes)\s*:.+$/i, '')
    .trim();
  return cap(title.replace(/\s+/g, ' '));
}

function eventLocationFromText(value) {
  const text = String(value || '');
  // Prefer the second "at" in "tomorrow at 3pm at Main Clinic".
  let explicit = text.match(/\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s+at\s+([^,;—–]+?)(?:\s+(?:on|tomorrow|today|next|this)\b|\s*$)/i);
  if (!explicit) explicit = text.match(/(?:\blocation\s*(?:is|:)|\bat)\s+([^,;—–]+?)(?:\s+(?:on|tomorrow|today|next|this)\b|\s*$)/i);
  if (!explicit) return '';
  const candidate = explicit[1].trim();
  // "at 7pm" is a time, never a location.
  if (/^\d{1,2}(?::\d{2})?\s*(?:am|pm)?$/i.test(candidate)) return '';
  return candidate.length > 2 ? candidate : '';
}

function eventNotesFromText(value) {
  const match = String(value || '').match(/(?:[—–]|\bnotes?\s*:)\s*(.+)$/i);
  return match ? match[1].trim() : '';
}

// helper functions
function cleanRemTitle(raw) {
  let s = String(raw || '').trim();
  const tail = [
    /\s+every\s+[\w\s]*$/i,
    /\s+(?:on\s+)?\d{4}-\d{1,2}-\d{1,2}$/i,
    /\s+(?:on\s+)?\d{1,2}[/.\-]\d{1,2}(?:[/.\-]\d{2,4})?$/i,
    /\s+(?:on\s+)?(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?$/i,
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

function splitDue(body) {
  const month = '(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)';
  const literalDate = `(?:${month}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:[\\s,]+\\d{4})?|\\d{1,2}(?:st|nd|rd|th)?\\s+${month}(?:[\\s,]+\\d{4})?|\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[/.\\-]\\d{1,2}(?:[/.\\-]\\d{2,4})?)`;
  const pats = [
    /\s+(?:by|before|due)\s+/i,
    /\s+at\s+(?:noon|midnight|\d[\d:.]*(?:\s*(?:am|pm))?)/i,
    /\s+tomorrow\b/i, /\s+tonight\b/i,
    /\s+this\s+(?:weekend|week|evening|morning|afternoon)\b/i,
    /\s+next\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
    /\s+next\s+(?:week|month|day)\b/i,
    /\s+in\s+\d+\s+(?:min|minute|hour|day|week)s?\b/i,
    /\s+(?:on|for)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
    new RegExp(`\\s+(?:on\\s+)?${literalDate}\\b`, 'i')
  ];
  let cut = -1;
  for (const pattern of pats) {
    const match = pattern.exec(body);
    if (match && (cut < 0 || match.index < cut)) cut = match.index;
  }
  if (cut < 0) return { title: body.trim(), due: '' };
  return { title: body.slice(0, cut).trim().replace(/\s+(?:for|on|to)\s*$/i, ''), due: body.slice(cut).trim() };
}

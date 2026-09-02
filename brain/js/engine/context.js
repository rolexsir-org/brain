// Minimal conversational context: supports follow-up references like
// "that", "it", "the last one", "change it", "delete that", "mark it done",
// and clarifying answers ("7pm", "Actually make it 650").

export class Context {
  constructor() {
    this.last = [];          // stack of recent touched records {type,id,label}
    this.pending = null;     // {kind, params:{...}, ask}
  }
  push(type, id, label) {
    this.last = this.last.filter(x => !(x.type === type && x.id === id));
    this.last.unshift({ type, id, label });
    if (this.last.length > 8) this.last.pop();
  }
  top(type) {
    if (!this.last.length) return null;
    return this.last[0];
  }
  /** Resolve a pronoun/pointer to the most recent matching record. */
  resolvePronoun(text, store) {
    const t = text.toLowerCase();
    if (/\b(that|it|this|the last one|that one|the one)\b/.test(t) && this.last.length) {
      return this.last[0];
    }
    return null;
  }
  setPending(kind, params, ask) { this.pending = { kind, params, ask }; }
  clearPending() { this.pending = null; }
}

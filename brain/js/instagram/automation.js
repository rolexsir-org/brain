// Two publishing permission modes — explicit, auditable, revokable.
// Mode1: Approval required (default). Mode2: Explicitly authorized automation.

import { STATES, normalizeStatus } from './stateMachine.js';

export function defaultAutomationSettings() {
  return {
    enabled: false,
    mode: 'MANUAL', // MANUAL | AUTOMATED
    rules: [], // array of automation rules
    paused: false,
    history: [], // execution history
    lastRunAt: null,
    createdAt: new Date().toISOString()
  };
}

// Rule schema: which videos are eligible
export function makeRule(raw = {}) {
  return {
    id: String(raw.id || `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`).slice(0,64),
    name: String(raw.name || 'Untitled rule').slice(0,100),
    enabled: raw.enabled !== false,
    // Eligibility filters — all must match for auto-publish
    filters: {
      // tag-based: drafts must have one of these tags (stored as hashtags or custom tag)
      tags: Array.isArray(raw.filters?.tags) ? raw.filters.tags.map(s=>String(s).slice(0,40)).filter(Boolean).slice(0,20) : [],
      // name pattern: glob/regex simplified to substring
      namePattern: String(raw.filters?.namePattern || '').slice(0,200),
      // schedule window
      allowedDays: Array.isArray(raw.filters?.allowedDays) ? raw.filters.allowedDays.map(Number).filter(n=>n>=0&&n<=6) : [1,2,3,4,5], // Mon-Fri default
      allowedHours: Array.isArray(raw.filters?.allowedHours) ? raw.filters.allowedHours : { start: 9, end: 17 },
      // specific draftIds explicitly included (owner must tick each)
      eligibleDraftIds: Array.isArray(raw.filters?.eligibleDraftIds) ? raw.filters.eligibleDraftIds.map(s=>String(s).slice(0,64)).filter(Boolean).slice(0,100) : []
    },
    schedule: {
      // when to attempt auto-publish
      freq: ['daily','weekly','manual'].includes(raw.schedule?.freq) ? raw.schedule.freq : 'daily',
      time: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(raw.schedule?.time)) ? String(raw.schedule.time) : '09:00',
      days: Array.isArray(raw.schedule?.days) ? raw.schedule.days.filter(n=>n>=0&&n<=6) : []
    },
    limits: {
      maxPerDay: Math.min(10, Math.max(1, Number(raw.limits?.maxPerDay) || 1)),
      requireApprovalAfterFailures: Number(raw.limits?.requireApprovalAfterFailures) || 2
    },
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

export function isEligibleForAutomation(draft, rule, automation) {
  if (!automation || !automation.enabled || automation.paused) return { eligible:false, reason:'Automation disabled or paused' };
  if (!rule || !rule.enabled) return { eligible:false, reason:'Rule disabled' };
  const status = normalizeStatus(draft.status);
  if (!['READY','AWAITING_APPROVAL','SCHEDULED'].includes(status)) return { eligible:false, reason:`Status ${status} not eligible` };
  // Must be explicitly in eligibleDraftIds — never assume all videos eligible
  const filters = rule.filters || {};
  if (filters.eligibleDraftIds && filters.eligibleDraftIds.length) {
    if (!filters.eligibleDraftIds.includes(draft.id)) return { eligible:false, reason:'Not in eligible list for this rule' };
  } else {
    // If no explicit IDs, check other filters but require at least one filter to be set
    const hasTagRule = filters.tags && filters.tags.length;
    const hasPattern = filters.namePattern && filters.namePattern.trim();
    if (!hasTagRule && !hasPattern) return { eligible:false, reason:'No eligibility criteria — explicitly add videos to rule' };
    if (hasTagRule) {
      const draftTags = (draft.hashtags || []).map(t=>t.toLowerCase());
      const match = filters.tags.some(tag => draftTags.includes(String(tag).toLowerCase()));
      if (!match) return { eligible:false, reason:'No matching tag' };
    }
    if (hasPattern) {
      const pat = String(filters.namePattern).toLowerCase();
      if (!String(draft.videoName||'').toLowerCase().includes(pat)) return { eligible:false, reason:'Name pattern mismatch' };
    }
  }
  // Time window check
  const now = new Date();
  const day = now.getDay();
  const hour = now.getHours();
  if (filters.allowedDays && !filters.allowedDays.includes(day)) return { eligible:false, reason:`Day ${day} not allowed` };
  if (filters.allowedHours) {
    const { start, end } = filters.allowedHours;
    if (hour < start || hour >= end) return { eligible:false, reason:`Hour ${hour} outside ${start}-${end}` };
  }
  return { eligible:true };
}

export function recordAutomationExecution(automation, entry) {
  const history = Array.isArray(automation.history) ? automation.history.slice() : [];
  history.unshift({
    at: new Date().toISOString(),
    draftId: entry.draftId || '',
    ruleId: entry.ruleId || '',
    action: entry.action || 'attempt',
    result: entry.result || 'unknown',
    error: String(entry.error||'').slice(0,500),
    actor: entry.actor || 'automation'
  });
  // keep last 200
  automation.history = history.slice(0,200);
  automation.lastRunAt = new Date().toISOString();
  return automation;
}

export function canAutomationPublish(automation) {
  if (!automation.enabled) return { ok:false, reason:'Automation disabled — enable in Automation Centre' };
  if (automation.paused) return { ok:false, reason:'Automation paused' };
  if (automation.mode !== 'AUTOMATED') return { ok:false, reason:'Mode is MANUAL — approval required' };
  const rules = (automation.rules||[]).filter(r=>r.enabled);
  if (!rules.length) return { ok:false, reason:'No enabled automation rules — configure eligible videos' };
  return { ok:true, rules };
}

export function pauseAutomation(automation) {
  automation.paused = true;
  automation.history = automation.history || [];
  automation.history.unshift({ at: new Date().toISOString(), action:'paused', actor:'user' });
  automation.history = automation.history.slice(0,200);
  return automation;
}

export function resumeAutomation(automation) {
  automation.paused = false;
  automation.history = automation.history || [];
  automation.history.unshift({ at: new Date().toISOString(), action:'resumed', actor:'user' });
  automation.history = automation.history.slice(0,200);
  return automation;
}

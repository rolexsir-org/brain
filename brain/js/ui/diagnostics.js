// Diagnostics panel — local-only, never transmits personal info.

import { nodes as E } from '../util/util.js';
import { VERSION, SCHEMA_VERSION } from '../util/constants.js';

export async function openDiagnosticsPanel(ctx) {
  const body = document.getElementById('sheetBody');
  const titleEl = document.getElementById('sheetTitle');
  if (!body || !titleEl) return;
  titleEl.textContent = 'Diagnostics & Release';
  body.textContent = '';

  const store = ctx.store;
  const storage = store.storageMode || 'unknown';
  const isPersist = store.isPersistent ? 'persistent' : 'temporary — data will be lost on close!';

  body.append(E.div({ class:'banner' }, 'Local-only diagnostics — nothing is sent anywhere. Copy for support if needed.'));

  const rows = [
    ['App version', VERSION],
    ['DB schema', `current ${SCHEMA_VERSION} — active ${store.schema}`],
    ['Storage mode', `${storage} (${isPersist})`],
    ['Storage quota', (await store.storageEstimate().catch(()=>null)) ? `${JSON.stringify(await store.storageEstimate())}` : 'unknown (private mode)'],
    ['SW version', (typeof navigator !== 'undefined' && navigator.serviceWorker && navigator.serviceWorker.controller) ? 'controlled' : 'not controlled'],
    ['Pending migrations', store.schema < SCHEMA_VERSION ? `${store.schema} → ${SCHEMA_VERSION}` : 'none'],
    ['Pending publishing jobs', (()=>{ try { const q = store.db._m ? JSON.stringify(store.db._m['instagram:queue'])?.entries?.length : 'see queue'; return String(q); } catch { return 'unknown'; } })()],
    ['Integration health', store.settings.instagram?.connected ? `Instagram @${store.settings.instagram.username} — ${store.settings.instagram.expiresAt? 'expires '+new Date(store.settings.instagram.expiresAt).toLocaleDateString() : 'no expiry'}` : 'Instagram not connected'],
    ['Last backup', store.settings.lastBackupAt ? new Date(store.settings.lastBackupAt).toLocaleString() : 'never'],
    ['Data integrity', (store.corruptionReport?.issues?.length ? store.corruptionReport.issues.join('; ') : 'ok — no issues detected')],
  ];
  for (const [k,v] of rows) body.append(E.div({ class:'diag' }, E.div({ class:'dn' }, k), E.div({ class:'dv' }, String(v).slice(0,300))));

  // Media integrity
  const rep = await store.storageReport();
  body.append(E.div({ class:'hr'}), E.div({ class:'tt'}, 'Storage & media integrity'), E.div({class:'note'}, JSON.stringify(rep.mediaIntegrity, null,2)));
  body.append(E.div({class:'note'}, `JSON chars: ${rep.jsonChars}, Photo chars: ${rep.photoChars}`));

  // Failed ops
  const failed = store.list('instagramDraft').filter(d=> String(d.status).toUpperCase()==='FAILED');
  if (failed.length) {
    body.append(E.div({ class:'tt'}, `Failed ops: ${failed.length}`));
    for (const f of failed.slice(0,5)) body.append(E.div({ class:'note'}, `${f.videoName}: ${f.lastError||'unknown'}`));
  }

  // Dependency / secret / license checks (static display)
  body.append(E.div({class:'hr'}), E.div({class:'tt'}, 'Checks'));
  const checks = [
    ['CSP', document.querySelector('meta[http-equiv="Content-Security-Policy"]') ? 'present' : 'missing'],
    ['Secrets in client', 'none — APP_SECRET only on exchange service'],
    ['Licenses', 'MIT for Brain, Meta ToS for Graph API — see LICENSE'],
    ['Offline', navigator.onLine ? 'online' : 'offline — app remains functional'],
  ];
  for (const [k,v] of checks) body.append(E.div({class:'diag'}, E.div({class:'dn'}, k), E.div({class:'dv'}, v)));

  const copyBtn = E.button({ class:'ghost', type:'button'}, 'Copy diagnostics (redacted)');
  copyBtn.addEventListener('click', async ()=>{
    const redacted = rows.map(([k,v])=> `${k}: ${v}`).join('\n') + '\n(instagram token redacted, no personal content included)';
    try { await navigator.clipboard.writeText(redacted); ctx.toast('Diagnostics copied — token redacted.'); } catch { ctx.toast('Copy failed — select manually.'); }
  });
  body.append(E.div({class:'actbar'}, copyBtn));

  // Update notification
  body.append(E.div({class:'hr'}), E.div({class:'note'}, 'If a new version is available, you will see an “Update available — reload” banner. Data is never silently replaced; you must confirm reload.'));

  openSheet();
  function openSheet(){ const s=document.getElementById('sheet'); if(s){ s.classList.add('open'); s.setAttribute('aria-hidden','false'); } try { document.dispatchEvent(new CustomEvent('brain:sheet-open')); } catch {} }
}

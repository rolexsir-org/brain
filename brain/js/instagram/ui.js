// Instagram section UI — connection status, draft library, video preview,
// caption/hashtag editor, publishing confirmation. Uses Brain's sheet + cards patterns.

import { nodes as E, escHtml } from '../util/util.js';
import { CONFIG, isConfigured } from './config.js';
import { validateFileBasics, probeVideoMetadata, createVideoObjectUrl, revokeVideoObjectUrl, validateCaption, validateHashtags, buildCaptionWithHashtags } from './media.js';
import { getLoginUrl, getConnectionStatus, isTokenExpired, tokenExpiryLabel, needsRefresh, buildDisconnectedConnection } from './auth.js';
import { suggestHashtags, generateCaptionTemplate, preparePublishPreview } from './publish.js';

let videoObjectUrl = null;
let pendingVideoFile = null;

function toastFn(ctx, msg) { if (ctx && ctx.toast) ctx.toast(msg); }

/** Entry: show Instagram hub */
export function openInstagramHub(ctx) {
  const body = document.getElementById('sheetBody');
  const title = document.getElementById('sheetTitle');
  if (!body || !title) return;
  title.textContent = 'Instagram';
  body.textContent = '';
  renderConnectionCard(ctx, body);
  renderDraftLibrary(ctx, body);
  renderPublishedHistory(ctx, body);
  openSheet();
}

/** Connection card */
function renderConnectionCard(ctx, parent) {
  const conn = getInstagramConnection(ctx);
  const status = getConnectionStatus(conn);
  const wrap = E.div({ class: 'ig-conn-card' });

  if (status === 'connected') {
    wrap.append(
      E.div({ class: 'banner' }, `✅ Connected as @${escHtml(conn.username || conn.igUserId)} · ${escHtml(conn.name || 'Business account')}`),
      E.div({ class: 'meta' }, `${tokenExpiryLabel(conn)} · ID ${String(conn.igUserId).slice(0, 8)}…`),
      conn.profilePictureUrl ? E.img({ src: conn.profilePictureUrl, alt: 'Profile', style: 'width:40px;height:40px;border-radius:50%;border:1px solid var(--line);margin-top:8px' }) : null
    );
    if (isTokenExpired(conn)) wrap.append(E.div({ class: 'note', style: 'color:var(--bad)' }, 'Access expired — reconnect to publish.'));
    else if (needsRefresh(conn)) wrap.append(E.div({ class: 'note' }, 'Token expires soon. Consider reconnecting.'));

    const row = E.div({ class: 'actbar' });
    const refreshBtn = E.button({ class: 'ghost', type: 'button' }, '↻ Check connection');
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true;
      try {
        const { validateToken } = await import('./api.js');
        const res = await validateToken(conn.accessToken);
        if (!res.ok) ctx.toast(res.error || 'Token invalid — please reconnect.');
        else ctx.toast('Connection valid.');
      } catch (e) { ctx.toast('Could not validate.'); }
      refreshBtn.disabled = false;
    });
    const disBtn = E.button({ class: 'ghost danger', type: 'button' }, 'Disconnect Instagram');
    disBtn.addEventListener('click', () => confirmDisconnect(ctx));
    row.append(refreshBtn, disBtn);
    wrap.append(row);
  } else if (status === 'expired') {
    wrap.append(
      E.div({ class: 'banner', style: 'background:rgba(255,109,109,.1);border-color:rgba(255,109,109,.3)' }, `⚠️ Connected as @${escHtml(conn.username)} but access expired.`),
      E.button({ class: 'primary', type: 'button', onclick: () => startOAuth(ctx) }, 'Reconnect Instagram')
    );
  } else {
    wrap.append(
      E.div({ class: 'banner' }, 'Connect your Instagram Business account to prepare and publish Reels. Brain will only publish what you explicitly approve.'),
      E.div({ class: 'note' }, 'Requires a Facebook Page linked to an Instagram Business/Creator account. Meta will ask you to allow instagram_basic and instagram_content_publish.'),
      !isConfigured() ? E.div({ class: 'note', style: 'color:var(--warn)' }, '⚙️ Not configured: set Brain Instagram App ID in hosting config. You can still prepare drafts locally and publish via manual token (see below).') : null
    );
    const btn = E.button({ class: 'primary', type: 'button' }, 'Connect Instagram');
    btn.addEventListener('click', () => startOAuth(ctx));
    wrap.append(btn);

    if (!isConfigured()) {
      const manual = E.div({ class: 'field', style: 'margin-top:12px' });
      manual.append(E.div({ class: 'note' }, 'Developer/test token entry (local only, never sent to Brain servers):'));
      const tokenInput = E.input({ type: 'password', placeholder: 'Paste long-lived access token (testing only)', class: 'ed' });
      const idInput = E.input({ type: 'text', placeholder: 'Instagram User ID (e.g. 1784…)', class: 'ed', style: 'margin-top:6px' });
      const userInput = E.input({ type: 'text', placeholder: 'Username (without @)', class: 'ed', style: 'margin-top:6px' });
      const saveBtn = E.button({ class: 'ghost', type: 'button', style: 'margin-top:6px' }, 'Save test connection locally');
      saveBtn.addEventListener('click', async () => {
        const token = tokenInput.value.trim();
        const igId = idInput.value.trim();
        if (!token || !igId) { ctx.toast('Enter both token and IG User ID.'); return; }
        const connObj = {
          connected: true, igUserId: igId, username: userInput.value.trim().replace(/^@/, ''), name: userInput.value.trim() || 'Test account',
          profilePictureUrl: '', pageId: '', accessToken: token, tokenType: 'bearer',
          expiresAt: new Date(Date.now() + 55 * 24 * 3600 * 1000).toISOString(),
          connectedAt: new Date().toISOString(), lastValidatedAt: new Date().toISOString(), scopes: ['instagram_basic', 'instagram_content_publish']
        };
        await saveInstagramConnection(ctx, connObj);
        ctx.toast('Test connection saved locally. Verify with “Check connection”.');
        openInstagramHub(ctx);
      });
      manual.append(tokenInput, idInput, userInput, saveBtn);
      wrap.append(manual);

      const appIdInput = E.input({ type: 'text', placeholder: 'Meta App ID (for OAuth redirect)', class: 'ed', style: 'margin-top:8px' });
      const saveAppId = E.button({ class: 'ghost', type: 'button', style: 'margin-top:6px' }, 'Save App ID locally');
      saveAppId.addEventListener('click', () => {
        const v = appIdInput.value.trim();
        if (!v) { ctx.toast('Enter App ID.'); return; }
        try { localStorage.setItem('brain:instagram:appId', v); ctx.toast('App ID saved — reload to use Connect.'); } catch { ctx.toast('Could not save.'); }
      });
      wrap.append(E.div({ class: 'hr' }), E.div({ class: 'note' }, 'Or set App ID for this browser:'), appIdInput, saveAppId);
    }
  }
  parent.append(wrap, E.div({ class: 'hr' }));
}

function startOAuth(ctx) {
  if (!isConfigured()) {
    ctx.toast('Instagram App ID not configured. Use manual token entry below or configure hosting.');
    return;
  }
  try {
    const { url } = getLoginUrl();
    if (typeof window !== 'undefined') window.location.href = url;
  } catch (e) { ctx.toast(e && e.message ? e.message : 'Cannot start OAuth.'); }
}

async function confirmDisconnect(ctx) {
  if (!window.confirm('Disconnect Instagram? You will need to reconnect to publish again. Drafts stay saved.')) return;
  await saveInstagramConnection(ctx, buildDisconnectedConnection());
  ctx.toast('Instagram disconnected. Drafts kept locally.');
  openInstagramHub(ctx);
}

// ── Draft library ──────────────────────────────────────────────────────────

function renderDraftLibrary(ctx, parent) {
  const drafts = ctx.store.list('instagramDraft').slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const header = E.div({ class: 'toggle', style: 'border:none;padding:6px 0' },
    E.div({ class: 'tt' }, `📼 Reel drafts · ${drafts.length}`, E.small({}, 'Select a local video and prepare captions'))
  );
  parent.append(header);

  const pickBtn = E.button({ class: 'primary', type: 'button' }, '＋ Select Reel video');
  pickBtn.addEventListener('click', () => openVideoPicker(ctx));
  parent.append(pickBtn);

  if (!drafts.length) {
    parent.append(E.div({ class: 'note' }, 'No drafts yet. Pick a video from your device to get started. It stays on this device until you publish.'));
    parent.append(E.div({ class: 'hr' }));
    return;
  }

  const list = E.div({ class: 'ig-draft-list' });
  for (const draft of drafts.slice(0, 20)) {
    list.append(renderDraftRow(ctx, draft));
  }
  parent.append(list);
  if (drafts.length > 20) parent.append(E.div({ class: 'note' }, `Showing 20 of ${drafts.length} drafts.`));
  parent.append(E.div({ class: 'hr' }));
}

function renderDraftRow(ctx, draft) {
  const row = E.div({ class: 'srow', style: 'align-items:center;padding:8px 0' });
  const icon = E.div({ class: 'em', style: 'background:linear-gradient(135deg,#feda75,#d62976,#4f5bd5)' }, '🎬');
  const tx = E.div({ class: 'tx' });
  const statusDot = { draft: '⚪', ready: '🟢', pending: '🟡', publishing: '⏳', published: '✅', failed: '❌', scheduled: '📅' }[draft.status] || '⚪';
  const subtitle = `${statusDot} ${draft.status} · ${draft.videoName || 'Reel'} · ${(draft.videoSize / 1048576).toFixed(1)} MB` +
    (draft.videoDuration ? ` · ${Math.round(draft.videoDuration)}s` : '') +
    (draft.lastError ? ` · ⚠️ ${String(draft.lastError).slice(0, 60)}` : '');
  tx.append(E.b({}, draft.caption ? String(draft.caption).slice(0, 50) || draft.videoName : draft.videoName), E.small({}, subtitle));
  if (draft.hashtags && draft.hashtags.length) tx.append(E.div({ class: 'att' }, draft.hashtags.map(t => `#${t}`).join(' ')));

  row.append(icon, tx);
  row.addEventListener('click', () => openDraftEditor(ctx, draft.id));
  row.style.cursor = 'pointer';
  return row;
}

// ── Video picker (local) ───────────────────────────────────────────────────

function openVideoPicker(ctx) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'video/mp4,video/quicktime,video/mov,video/x-m4v,.mp4,.mov,.m4v';
  input.setAttribute('aria-label', 'Select Reel video');
  input.style.display = 'none';
  document.body.appendChild(input);
  let handled = false;
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.remove();
    if (!file || handled) return;
    handled = true;
    await handleVideoSelected(ctx, file);
  });
  input.addEventListener('cancel', () => { input.remove(); }, { once: true });
  setTimeout(() => window.addEventListener('focus', () => setTimeout(() => { if (input.isConnected && !input.files.length) { input.remove(); } }, 300), { once: true }), 0);
  try { input.click(); } catch { input.remove(); ctx.toast('Could not open video picker.'); }
}

async function handleVideoSelected(ctx, file) {
  const basic = validateFileBasics(file);
  if (!basic.ok) { ctx.toast(basic.errors[0]); return; }
  // Probe in background
  const probed = await probeVideoMetadata(file);
  if (probed.errors.length) { ctx.toast(probed.errors[0]); return; }
  if (probed.warnings.length) ctx.toast(probed.warnings[0]);

  // Create object URL for preview
  if (videoObjectUrl) revokeVideoObjectUrl(videoObjectUrl);
  videoObjectUrl = createVideoObjectUrl(file);
  pendingVideoFile = file;

  // Create draft immediately so it persists
  const draft = ctx.store.addSync('instagramDraft', {
    videoName: file.name,
    videoMime: file.type || 'video/mp4',
    videoSize: file.size,
    videoWidth: probed.width || 0,
    videoHeight: probed.height || 0,
    videoDuration: probed.durationSec || 0,
    caption: '',
    hashtags: [],
    status: 'draft'
  });
  if (!draft) { ctx.toast('Could not save draft — storage may be full.'); return; }
  // Store file blob separately for hosting later (not in backup JSON)
  try {
    if (ctx.store.db) await ctx.store.db.kvSet(`igVideoBlob:${draft.id}`, { name: file.name, type: file.type, size: file.size, at: new Date().toISOString() });
  } catch {}
  await ctx.store.flush().catch(() => {});
  // Also keep file in memory for preview
  pendingVideoFile._draftId = draft.id;
  openDraftEditor(ctx, draft.id, file);
  ctx.toast('Draft created — add caption and hashtags.');
}

// ── Draft editor ───────────────────────────────────────────────────────────

export function openDraftEditor(ctx, draftId, fileOverride) {
  const draft = ctx.store.get('instagramDraft', draftId);
  if (!draft) { toastFn(ctx, 'Draft not found.'); return; }
  const file = fileOverride || pendingVideoFile;

  const body = document.getElementById('sheetBody');
  const titleEl = document.getElementById('sheetTitle');
  if (!body || !titleEl) return;
  titleEl.textContent = draft.status === 'published' ? 'Published Reel' : 'Edit Reel draft';
  body.textContent = '';

  // Video preview
  const previewWrap = E.div({ class: 'center' });
  if (videoObjectUrl && file && file._draftId === draftId) {
    const vid = E.el('video', { controls: 'true', playsinline: 'true', style: 'max-width:100%;max-height:42vh;border-radius:12px;border:1px solid var(--line)', src: videoObjectUrl });
    previewWrap.append(vid);
  } else if (draft.videoName) {
    previewWrap.append(E.div({ class: 'note', style: 'padding:12px;border:1px dashed var(--line);border-radius:10px' }, `📼 ${escHtml(draft.videoName)} — ${draft.videoWidth || '?'}×${draft.videoHeight || '?'} · ${draft.videoDuration ? Math.round(draft.videoDuration) + 's' : '—'} · ${(draft.videoSize / 1048576).toFixed(1)} MB`));
    previewWrap.append(E.div({ class: 'note' }, 'Preview unavailable — re-select video to preview before publishing.'));
  }
  body.append(previewWrap);
  body.append(E.div({ class: 'meta', style: 'margin-top:8px;text-align:center' }, `${draft.status} · ${draft.videoName}`));

  // Caption
  const capInput = E.textarea({ class: 'ed', rows: '3', placeholder: 'Write a caption… (2200 chars max)', style: 'margin-top:10px' }, draft.caption || '');
  body.append(E.div({ class: 'field' }, E.label({}, 'Caption'), capInput));
  const capCount = E.div({ class: 'att' }, `${(draft.caption || '').length}/2200`);
  capInput.addEventListener('input', () => { capCount.textContent = `${capInput.value.length}/2200`; });
  body.append(capCount);

  // Hashtags
  const hashInput = E.input({ type: 'text', class: 'ed', placeholder: 'Add hashtags without # — comma separated', value: (draft.hashtags || []).join(', ') });
  body.append(E.div({ class: 'field' }, E.label({}, 'Hashtags'), hashInput));
  body.append(E.div({ class: 'att' }, 'Up to 30 · e.g. travel, reels, viral'));

  // Smart buttons
  const smartRow = E.div({ class: 'actbar' });
  const genCap = E.button({ class: 'ghost', type: 'button' }, '✨ Generate caption');
  genCap.addEventListener('click', () => { capInput.value = generateCaptionTemplate(draft.videoName.replace(/\.[^.]+$/, '')); capCount.textContent = `${capInput.value.length}/2200`; });
  const suggestBtn = E.button({ class: 'ghost', type: 'button' }, '# Suggest hashtags');
  suggestBtn.addEventListener('click', () => {
    const s = suggestHashtags(capInput.value || draft.videoName, '');
    const existing = hashInput.value.split(',').map(x => x.trim()).filter(Boolean);
    const merged = [...new Set([...existing, ...s])].slice(0, 30);
    hashInput.value = merged.join(', ');
  });
  smartRow.append(genCap, suggestBtn);
  body.append(smartRow);

  // Temp hosting URL (required for Meta fetch)
  const hostWrap = E.div({ class: 'field', style: 'margin-top:10px' },
    E.label({}, 'Temporary video URL (for Meta) — required to publish'),
    E.input({ type: 'url', class: 'ed', placeholder: 'https://…/your-video.mp4 — Meta must fetch the approved video', value: draft.tempVideoUrl || '' })
  );
  const hostInput = hostWrap.querySelector('input');
  body.append(hostWrap);
  body.append(E.div({ class: 'note' }, 'Meta must fetch your video from a public HTTPS URL. Brain only sends the URL you approve. This is not private from Meta. Use your own hosting or a minimal exchange service that deletes the file after publish.'));

  const actions = E.div({ class: 'actbar', style: 'margin-top:14px' });

  const saveBtn = E.button({ class: 'primary', type: 'button' }, 'Save draft');
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    const hashtags = hashInput.value.split(',').map(x => x.trim().replace(/^#/, '')).filter(Boolean);
    const vCap = validateCaption(capInput.value);
    if (!vCap.ok) { toastFn(ctx, vCap.errors[0]); saveBtn.disabled = false; return; }
    const vHash = validateHashtags(hashtags);
    if (!vHash.ok) { toastFn(ctx, vHash.errors[0]); saveBtn.disabled = false; return; }
    const updated = await ctx.store.update('instagramDraft', draftId, {
      caption: capInput.value.trim().slice(0, 2200),
      hashtags,
      tempVideoUrl: hostInput.value.trim().slice(0, 2000) || null,
      status: (capInput.value.trim() || hashtags.length) ? 'ready' : 'draft'
    });
    if (!updated) toastFn(ctx, 'Could not save — storage error.');
    else { toastFn(ctx, 'Draft saved.'); openInstagramHub(ctx); }
    saveBtn.disabled = false;
  });

  const previewPublishBtn = E.button({ class: 'ghost', type: 'button' }, 'Eye Preview publishing…');
  previewPublishBtn.addEventListener('click', async () => {
    // Save first
    const hashtags = hashInput.value.split(',').map(x => x.trim().replace(/^#/, '')).filter(Boolean);
    await ctx.store.update('instagramDraft', draftId, { caption: capInput.value.trim(), hashtags, tempVideoUrl: hostInput.value.trim() || null });
    const fresh = ctx.store.get('instagramDraft', draftId);
    const conn = getInstagramConnection(ctx);
    const prep = preparePublishPreview(fresh, conn);
    if (!prep.ok) { toastFn(ctx, prep.error); return; }
    openPublishConfirm(ctx, draftId, prep.preview);
  });

  const deleteBtn = E.button({ class: 'ghost danger', type: 'button' }, 'Delete draft');
  deleteBtn.addEventListener('click', async () => {
    if (!window.confirm(`Delete “${draft.videoName}”?`)) return;
    const removed = await ctx.store.remove('instagramDraft', draftId);
    if (removed) { toastFn(ctx, 'Draft deleted.'); openInstagramHub(ctx); }
    else toastFn(ctx, 'Could not delete.');
  });

  actions.append(saveBtn, previewPublishBtn, deleteBtn);

  if (draft.status === 'published' && draft.permalink) {
    const link = E.a({ href: draft.permalink, target: '_blank', rel: 'noopener noreferrer', class: 'ghost', style: 'display:block;text-align:center;text-decoration:none;margin-top:6px' }, 'View on Instagram ↗');
    actions.append(link);
  } else if (draft.permalink) {
    actions.append(E.a({ href: draft.permalink, target: '_blank', rel: 'noopener noreferrer', class: 'ghost', style: 'display:block' }, 'Open link'));
  }

  body.append(actions);
  body.append(E.button({ class: 'ghost', type: 'button', onclick: () => openInstagramHub(ctx) }, '← Back to Instagram'));
  openSheet();
}

// ── Publish confirmation (ABSOLUTE RULE) ───────────────────────────────────

function openPublishConfirm(ctx, draftId, preview) {
  const body = document.getElementById('sheetBody');
  const titleEl = document.getElementById('sheetTitle');
  if (!body || !titleEl) return;
  titleEl.textContent = 'Confirm publishing';
  body.textContent = '';

  body.append(E.div({ class: 'banner', style: 'background:rgba(62,207,142,.12);border-color:rgba(62,207,142,.35)' }, '⚠️ This will publish to your Instagram Business account. No Reel is sent until you tap Publish.'));

  const card = E.div({ class: 'card', style: 'margin-top:8px' });
  card.append(E.div({ class: 'k' }, '🎬 REEL PREVIEW'));
  card.append(E.div({ class: 't' }, preview.videoName));
  card.append(E.div({ class: 'meta' }, preview.videoMeta));
  card.append(E.div({ class: 'meta', style: 'white-space:pre-wrap;margin-top:6px' }, preview.caption || '(no caption)'));
  if (preview.hashtags && preview.hashtags.length) card.append(E.div({ class: 'att' }, preview.hashtags.map(t => `#${t}`).join(' ')));
  card.append(E.div({ class: 'meta', style: 'margin-top:6px' }, `Account: @${preview.username} · ${preview.igUserId}`));
  card.append(E.div({ class: 'att' }, `Video URL: ${preview.videoUrl.slice(0, 80)}…`));
  body.append(card);

  body.append(E.div({ class: 'note', style: 'margin-top:10px' }, 'By publishing you confirm this video is yours and complies with Instagram’s terms. Brain will create a container, wait for Meta to process it, then publish. Status is tracked locally.'));

  const btnRow = E.div({ class: 'actbar', style: 'margin-top:12px' });
  const publishBtn = E.button({ class: 'primary', type: 'button' }, '✅ Publish Reel to Instagram');
  const cancelBtn = E.button({ class: 'ghost', type: 'button' }, 'Cancel');

  cancelBtn.addEventListener('click', () => openDraftEditor(ctx, draftId));

  publishBtn.addEventListener('click', async () => {
    publishBtn.disabled = true;
    publishBtn.textContent = 'Publishing…';
    const progressEl = E.div({ class: 'note', style: 'margin-top:8px' }, 'Sending to Meta…');
    body.append(progressEl);
    try {
      const { executePublish } = await import('./publish.js');
      const conn = getInstagramConnection(ctx);
      const res = await executePublish(ctx.store, draftId, conn, {
        onProgress: (stage, msg) => { progressEl.textContent = `${stage}: ${msg}`; }
      });
      if (!res.ok) {
        if (res.authExpired) toastFn(ctx, 'Access expired — reconnect Instagram.');
        else toastFn(ctx, res.error || 'Publish failed.');
        publishBtn.disabled = false;
        publishBtn.textContent = '✅ Publish Reel to Instagram';
        progressEl.textContent = `Failed: ${res.error || 'Unknown'}`;
        return;
      }
      progressEl.textContent = res.permalink ? `✅ Published! ${res.permalink}` : '✅ Published!';
      toastFn(ctx, 'Reel published!');
      if (res.permalink) body.append(E.a({ href: res.permalink, target: '_blank', rel: 'noopener noreferrer', class: 'primary', style: 'display:block;text-align:center;margin-top:8px;text-decoration:none' }, 'View on Instagram ↗'));
      body.append(E.button({ class: 'ghost', type: 'button', onclick: () => openInstagramHub(ctx), style: 'margin-top:8px' }, 'Back to Instagram'));
      publishBtn.remove();
      cancelBtn.remove();
    } catch (e) {
      toastFn(ctx, e && e.message ? e.message : 'Publish threw.');
      publishBtn.disabled = false;
      publishBtn.textContent = '✅ Publish Reel to Instagram';
    }
  });

  btnRow.append(publishBtn, cancelBtn);
  body.append(btnRow);
}

// ── History ──────────────────────────────────────────────────────────────────

function renderPublishedHistory(ctx, parent) {
  const pubs = ctx.store.list('instagramPublication').slice().sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
  if (!pubs.length) return;
  parent.append(E.div({ class: 'toggle', style: 'border:none;padding:6px 0' }, E.div({ class: 'tt' }, `✅ Published · ${pubs.length}`)));
  for (const pub of pubs.slice(0, 10)) {
    const row = E.div({ class: 'srow' },
      E.div({ class: 'em' }, '✅'),
      E.div({ class: 'tx' }, E.b({}, pub.videoName || 'Reel'), E.small({}, `${new Date(pub.publishedAt).toLocaleDateString()} · ${pub.caption ? String(pub.caption).slice(0, 60) : ''}`))
    );
    if (pub.permalink) {
      const link = E.a({ href: pub.permalink, target: '_blank', rel: 'noopener noreferrer', class: 'mini', style: 'align-self:center' }, 'View');
      row.append(link);
    }
    parent.append(row);
  }
  parent.append(E.div({ class: 'hr' }));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getInstagramConnection(ctx) {
  if (ctx && ctx.store && ctx.store.settings && ctx.store.settings.instagram) return ctx.store.settings.instagram;
  return buildDisconnectedConnection();
}

async function saveInstagramConnection(ctx, connection) {
  if (!ctx || !ctx.store) return null;
  return ctx.store.updateSettings({ instagram: connection });
}

function openSheet() {
  const sheet = document.getElementById('sheet');
  if (sheet) { sheet.classList.add('open'); sheet.setAttribute('aria-hidden', 'false'); }
  const btn = document.getElementById('menuBtn');
  if (btn) btn.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => {
    const focusable = [...document.querySelectorAll('#sheet button:not([disabled]), #sheet input:not([disabled]), #sheet textarea:not([disabled])')].filter(el => !el.hidden);
    const target = focusable.find(el => el.id !== 'sheetClose') || focusable[0] || sheet;
    if (target && target.focus) try { target.focus({ preventScroll: true }); } catch {}
  });
}

export { openVideoPicker, getInstagramConnection, saveInstagramConnection };

// Account insights — local + Graph API when available.
// Fallback to local publishing stats when insights scope not granted.
import { CONFIG } from './config.js';

export async function fetchInsights(igUserId, accessToken, metrics = ['impressions','reach','profile_views']) {
  if (!igUserId || !accessToken) return { ok:false, error:'Not connected' };
  try {
    const url = new URL(`${CONFIG.graphBase}/${igUserId}/insights`);
    url.searchParams.set('metric', metrics.join(','));
    url.searchParams.set('period', 'day');
    url.searchParams.set('access_token', accessToken);
    const res = await fetch(url.toString());
    if (!res.ok) {
      const body = await res.text();
      let msg = `Insights failed (${res.status})`;
      try { const j=JSON.parse(body); msg=j.error?.message || msg; } catch {}
      return { ok:false, error: msg, needsPermission: res.status===403 };
    }
    const data = await res.json();
    return { ok:true, data: data.data || [], raw:data };
  } catch (e) {
    return { ok:false, error: e.message || 'Network error' };
  }
}

export function localInsights(store) {
  const drafts = store.list('instagramDraft');
  const pubs = store.list('instagramPublication');
  const all = [...drafts, ...pubs];
  const byStatus = {};
  for (const d of drafts) {
    const s = String(d.status||'DRAFT').toUpperCase();
    byStatus[s] = (byStatus[s]||0)+1;
  }
  const publishedThisMonth = (() => {
    const now = new Date();
    const key = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    return all.filter(d=>{
      const at = d.publishedAt || d.createdAt;
      if (!at) return false;
      return String(at).slice(0,7)===key && String(d.status).toUpperCase()==='PUBLISHED';
    }).length;
  })();
  const failed = drafts.filter(d=>String(d.status).toUpperCase()==='FAILED').length;
  const queueLen = drafts.filter(d=>['READY','AWAITING_APPROVAL','SCHEDULED','UPLOADING','PROCESSING'].includes(String(d.status).toUpperCase())).length;
  return { ok:true, local:true, byStatus, totalDrafts:drafts.length, publishedThisMonth, failed, queueLen };
}

export function formatInsightsReport(result) {
  if (!result.ok) return `Insights unavailable: ${result.error}`;
  if (result.local) {
    return `Local summary — Total drafts: ${result.totalDrafts}, Queue: ${result.queueLen}, Published this month: ${result.publishedThisMonth}, Failed: ${result.failed}`;
  }
  const lines = (result.data||[]).map(m=>`${m.name}: ${m.values?.[0]?.value ?? '—'}`);
  return lines.length ? lines.join('\\n') : 'No insights data yet.';
}

// Instagram Reels media validation against Meta's current requirements
// Validates locally without uploading. Never modifies original media silently.

import { MEDIA_REQUIREMENTS } from './config.js';

const ALLOWED_MIMES = new Set(MEDIA_REQUIREMENTS.mimeTypes.map(m => m.toLowerCase()));
const ALLOWED_EXTS = new Set(['mp4', 'mov', 'm4v', 'quicktime']);

function safeText(value, max = 500) {
  return String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, max);
}

/**
 * Validate a File object against Meta Reels publishing requirements.
 * Returns { ok, errors:[], warnings:[], meta:{ width,height,durationSec,aspectLabel } }
 * This is synchronous on metadata that can be derived from File; duration/resolution
 * requires probing via HTMLVideoElement (see probeVideoMetadata).
 */
export function validateFileBasics(file) {
  const errors = [];
  const warnings = [];
  if (!file || typeof file !== 'object' || typeof file.name !== 'string') {
    return { ok: false, errors: ['No video file provided.'], warnings, meta: null };
  }
  const name = safeText(file.name, 260);
  const ext = name.split('.').pop().toLowerCase();
  const mime = String(file.type || '').toLowerCase().split(';')[0].trim();

  if (mime && !ALLOWED_MIMES.has(mime) && !mime.startsWith('video/')) {
    errors.push(`Unsupported video type "${mime}". Use MP4 (H.264) or MOV.`);
  } else if (ext && !ALLOWED_EXTS.has(ext) && ext !== 'mp4') {
    warnings.push(`File extension .${ext} may not be supported. Prefer .mp4.`);
  }

  const size = Number(file.size) || 0;
  if (!Number.isFinite(size) || size <= 0) {
    errors.push('File appears to be empty or unreadable.');
  } else if (size > MEDIA_REQUIREMENTS.maxFileSizeBytes) {
    errors.push(`File is ${(size / 1048576).toFixed(1)} MB — exceeds 1 GB limit.`);
  } else if (size > MEDIA_REQUIREMENTS.clientMaxFileSizeBytes || size > 250 * 1024 * 1024) {
    warnings.push(`Large file (${(size / 1048576).toFixed(0)} MB) may fail on mobile networks.`);
  }

  return { ok: errors.length === 0, errors, warnings, meta: { size, name, mime, ext } };
}

/**
 * Probe video metadata via HTMLVideoElement without uploading.
 * Requires browser environment; falls back to basic validation in tests.
 */
export function probeVideoMetadata(file) {
  return new Promise(resolve => {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
      resolve({ width: 0, height: 0, durationSec: 0, aspectRatio: 0, aspectLabel: 'unknown', errors: [], warnings: ['Cannot probe video without browser APIs.'] });
      return;
    }
    let video;
    let objectUrl;
    let timeout;
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (video) {
        video.removeAttribute('src');
        try { video.load(); } catch {}
      }
      if (objectUrl) {
        try { URL.revokeObjectURL(objectUrl); } catch {}
      }
    };
    const finish = (result) => { cleanup(); resolve(result); };

    timeout = setTimeout(() => finish({ width: 0, height: 0, durationSec: 0, aspectRatio: 0, aspectLabel: 'unknown', errors: ['Timed out reading video metadata. Try a smaller file.'], warnings: [] }), 15000);

    try {
      if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
        finish({ width: 0, height: 0, durationSec: 0, aspectRatio: 0, aspectLabel: 'unknown', errors: [], warnings: ['Browser cannot create video preview.'] });
        return;
      }
      objectUrl = URL.createObjectURL(file);
      video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;
      video.onloadedmetadata = () => {
        const width = video.videoWidth || 0;
        const height = video.videoHeight || 0;
        const durationSec = Number.isFinite(video.duration) ? video.duration : 0;
        const errors = [];
        const warnings = [];

        if (durationSec && durationSec < MEDIA_REQUIREMENTS.minDurationSec) {
          errors.push(`Video is ${durationSec.toFixed(1)}s — minimum is ${MEDIA_REQUIREMENTS.minDurationSec}s.`);
        }
        if (durationSec && durationSec > MEDIA_REQUIREMENTS.maxDurationSec) {
          errors.push(`Video is ${Math.round(durationSec)}s — maximum is ${MEDIA_REQUIREMENTS.maxDurationSec / 60} min.`);
        }
        if (durationSec > MEDIA_REQUIREMENTS.recommendedMaxDurationSec) {
          warnings.push(`Reels longer than ${MEDIA_REQUIREMENTS.recommendedMaxDurationSec}s may be trimmed. Consider cutting to 90s.`);
        }
        if (width && height) {
          if (width < MEDIA_REQUIREMENTS.minWidth || height < MEDIA_REQUIREMENTS.minHeight) {
            warnings.push(`Resolution ${width}×${height} is below recommended 720p. Use 1080×1920 for best quality.`);
          }
          const ratio = width / height;
          // Reels prefers 9:16 (0.5625) — allow 4:5 and 1:1 as well
          const isPortrait = ratio < 1.05;
          if (!isPortrait) warnings.push('Landscape video may be cropped. Use 9:16 portrait for Reels.');
        }

        const aspectRatio = width && height ? width / height : 0;
        const aspectLabel = labelAspect(width, height);
        finish({ width, height, durationSec, aspectRatio, aspectLabel, errors, warnings });
      };
      video.onerror = () => finish({ width: 0, height: 0, durationSec: 0, aspectRatio: 0, aspectLabel: 'unknown', errors: ['Cannot read video: file may be corrupt or unsupported codec. Use H.264 MP4.'], warnings: [] });
      video.src = objectUrl;
    } catch (err) {
      finish({ width: 0, height: 0, durationSec: 0, aspectRatio: 0, aspectLabel: 'unknown', errors: [err && err.message ? err.message : 'Failed to probe video.'], warnings: [] });
    }
  });
}

function labelAspect(w, h) {
  if (!w || !h) return 'unknown';
  const r = w / h;
  if (Math.abs(r - 9/16) < 0.07) return '9:16';
  if (Math.abs(r - 4/5) < 0.07) return '4:5';
  if (Math.abs(r - 1) < 0.07) return '1:1';
  if (r > 1) return 'landscape';
  return `${w}:${h}`;
}

/**
 * Full validation: basic + probe
 */
export async function validateVideo(file) {
  const basic = validateFileBasics(file);
  if (!basic.ok) return basic;
  const probed = await probeVideoMetadata(file);
  const errors = [...basic.errors, ...probed.errors];
  const warnings = [...basic.warnings, ...probed.warnings];
  return { ok: errors.length === 0, errors, warnings, meta: { ...basic.meta, ...probed } };
}

export function validateCaption(caption) {
  const text = safeText(caption, 5000).trim();
  const errors = [];
  const warnings = [];
  if (text.length > MEDIA_REQUIREMENTS.captionMaxLength) {
    errors.push(`Caption is ${text.length} characters — limit is ${MEDIA_REQUIREMENTS.captionMaxLength}.`);
  }
  if (text.length === 0) warnings.push('Caption is empty. Add a description to help your Reel reach viewers.');
  return { ok: errors.length === 0, errors, warnings, length: text.length };
}

export function validateHashtags(hashtags) {
  const errors = [];
  const warnings = [];
  const tags = Array.isArray(hashtags) ? hashtags : [];
  if (tags.length > MEDIA_REQUIREMENTS.hashtagMaxCount) {
    errors.push(`Too many hashtags (${tags.length}) — maximum is ${MEDIA_REQUIREMENTS.hashtagMaxCount}.`);
  }
  const invalid = tags.filter(t => /[^a-zA-Z0-9_]/.test(String(t)) || String(t).length > 80);
  if (invalid.length) errors.push(`Invalid hashtags: ${invalid.slice(0, 5).join(', ')}`);
  if (tags.length === 0) warnings.push('Add 3–8 relevant hashtags to improve discovery.');
  return { ok: errors.length === 0, errors, warnings, count: tags.length };
}

export function buildCaptionWithHashtags(caption, hashtags) {
  const base = safeText(caption || '', 2200).trim();
  const tags = Array.isArray(hashtags) ? hashtags.map(t => String(t).trim().replace(/^#/, '')).filter(Boolean) : [];
  const suffix = tags.length ? '\n\n' + tags.map(t => `#${t}`).join(' ') : '';
  const full = base + suffix;
  if (full.length > 2200) {
    // Truncate caption to fit hashtags
    const allowedBase = 2200 - suffix.length - 3;
    return base.slice(0, Math.max(0, allowedBase)) + '…' + suffix;
  }
  return full;
}

// Video file helpers
export function createVideoObjectUrl(file) {
  try {
    if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') return URL.createObjectURL(file);
  } catch {}
  return null;
}

export function revokeVideoObjectUrl(url) {
  if (!url) return;
  try { URL.revokeObjectURL(url); } catch {}
}

export function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60).toString().padStart(2, '0');
  return m ? `${m}:${s}` : `0:${s}`;
}

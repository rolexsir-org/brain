// Cover selection — extract frame from video for Instagram cover_url.
// Uses canvas to grab a frame at given time offset, uploads as data URL for preview.
// The actual Graph API cover_url param expects a hosted image URL — we document
// that tempUpload covers work same as video_url when using direct upload.

export async function extractCoverFrame(videoUrl, timeSec = 1) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.preload = 'metadata';
    video.src = videoUrl;
    const timeout = setTimeout(()=>{ cleanup(); reject(new Error('Timeout extracting cover frame')); }, 15000);
    function cleanup(){ clearTimeout(timeout); video.remove(); }
    video.addEventListener('loadedmetadata', () => {
      const t = Math.min(Math.max(0, timeSec), Math.max(0, video.duration - 0.1));
      video.currentTime = t;
    });
    video.addEventListener('seeked', () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth || 720;
        canvas.height = video.videoHeight || 1280;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        cleanup();
        resolve({ dataUrl, width: canvas.width, height: canvas.height, timeSec: video.currentTime });
      } catch (e) { cleanup(); reject(e); }
    });
    video.addEventListener('error', () => { cleanup(); reject(new Error('Video load failed for cover')); });
  });
}

export function coverPickerUI(draft, onSelect) {
  const wrap = document.createElement('div');
  wrap.className = 'instagram-cover-picker';
  wrap.innerHTML = `
    <p class="muted" style="margin:4px 0 8px;">Pick a cover frame — drag the slider to choose a moment from your video.</p>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
      <input type="range" class="cover-time" min="0" max="100" value="10" style="flex:1;">
      <button class="btn" data-action="cover-preview">Preview</button>
      <button class="btn" data-action="cover-save">Use this frame</button>
    </div>
    <div class="cover-preview" style="display:flex;justify-content:center;min-height:120px;align-items:center;background:#f3f4f6;border-radius:8px;overflow:hidden;">
      <span class="muted">Preview will appear here</span>
    </div>
    <p class="muted" style="font-size:12px;margin-top:6px;">Note: covers use a hosted image URL. When you publish, Brain includes your chosen cover via the Graph API cover_url parameter. For local previews we use a data URL.</p>
  `;
  const slider = wrap.querySelector('.cover-time');
  const preview = wrap.querySelector('.cover-preview');
  let currentDataUrl = draft.coverDataUrl || null;
  let currentTime = Number(draft.coverTimeSec) || 1;

  // initialize slider max to duration if known
  if (draft.durationSec) { slider.max = String(Math.max(1, Math.floor(draft.durationSec))); slider.value = String(Math.min(currentTime, Number(slider.max))); }

  function setPreviewLoading(){
    preview.textContent='';
    const span=document.createElement('span');
    span.className='muted';
    span.textContent='Extracting frame…';
    preview.append(span);
  }
  function setPreviewImage(dataUrl, alt){
    preview.textContent='';
    const img=document.createElement('img');
    img.src=dataUrl;
    img.alt=alt;
    img.style.cssText='max-width:200px;max-height:360px;object-fit:contain;border-radius:6px;';
    preview.append(img);
  }
  wrap.querySelector('[data-action="cover-preview"]').addEventListener('click', async () => {
    if (!draft.videoUrl) { preview.textContent='No video URL — set video first'; return; }
    setPreviewLoading();
    try {
      const t = Number(slider.value) || 1;
      const res = await extractCoverFrame(draft.videoUrl, t);
      currentDataUrl = res.dataUrl; currentTime = res.timeSec;
      setPreviewImage(res.dataUrl, 'Cover preview');
    } catch (e) { preview.textContent = e.message; }
  });
  wrap.querySelector('[data-action="cover-save"]').addEventListener('click', () => {
    if (!currentDataUrl) {
      // Inline, announced feedback instead of a blocking alert().
      preview.textContent = '';
      const note = document.createElement('span');
      note.className = 'muted';
      note.setAttribute('role', 'status');
      note.textContent = 'Preview a frame first, then choose it.';
      preview.append(note);
      return;
    }
    onSelect({ coverDataUrl: currentDataUrl, coverTimeSec: currentTime });
  });
  if (currentDataUrl) {
    setPreviewImage(currentDataUrl, 'Current cover');
  }
  return wrap;
}

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ─── State ───
const state = {
  pdf: null,
  audio: null,
  pages: [],
  currentPage: 0,
  totalPages: 0,
  chunks: [],
  chunkIndex: 0,
  playing: false,
  speed: 1,
  speeds: [0.75, 1, 1.25, 1.5, 2],
  speedIndex: 1,
  pdfLoaded: false,
  audioLoaded: false,
  currentPdfId: null,
  currentAudioId: null,
  _lastPosSave: 0,
};

const $ = id => document.getElementById(id);
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// ─── IndexedDB ───
const DB_NAME = 'audiobookReader';
const DB_VERSION = 1;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('files')) {
        db.createObjectStore('files', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function idbRequest(mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction('files', mode);
    const store = tx.objectStore('files');
    const req = fn(store);
    if (req && 'onsuccess' in req) {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } else {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }
  }));
}

const dbPut = rec => idbRequest('readwrite', s => s.put(rec));
const dbGet = id => idbRequest('readonly', s => s.get(id));
const dbGetAll = () => idbRequest('readonly', s => s.getAll());
const dbDelete = id => idbRequest('readwrite', s => s.delete(id));

// ─── Session storage ───
const SESSION_KEY = 'audiobookSession';
const POSITIONS_KEY = 'audiobookPositions';

function saveSession() {
  const data = {
    pdfId: state.currentPdfId,
    audioId: state.currentAudioId,
    pdfPage: state.currentPage,
    chunkIndex: state.chunkIndex,
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(data));
}

function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }
  catch { return null; }
}

function saveAudioPosition(audioId, time) {
  if (!audioId || !isFinite(time)) return;
  let positions;
  try { positions = JSON.parse(localStorage.getItem(POSITIONS_KEY) || '{}'); }
  catch { positions = {}; }
  positions[audioId] = time;
  localStorage.setItem(POSITIONS_KEY, JSON.stringify(positions));
}

function getAudioPosition(audioId) {
  if (!audioId) return 0;
  try {
    const positions = JSON.parse(localStorage.getItem(POSITIONS_KEY) || '{}');
    return positions[audioId] || 0;
  } catch { return 0; }
}

function saveAll() {
  if (state.audio && state.currentAudioId) {
    saveAudioPosition(state.currentAudioId, state.audio.currentTime);
  }
  saveSession();
}

// ─── Bookmarks ───
const BOOKMARKS_KEY = 'audiobookBookmarks';

function getBookmarks() {
  try { return JSON.parse(localStorage.getItem(BOOKMARKS_KEY) || '[]'); }
  catch { return []; }
}

function setBookmarks(list) {
  localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(list));
}

function addBookmark() {
  if (!state.currentPdfId) {
    alert('Lade zuerst ein PDF, bevor du eine Stelle speicherst.');
    return;
  }
  const defaultLabel = `Seite ${state.currentPage + 1}` +
    (state.audio ? ` · ${formatTime(state.audio.currentTime)}` : '');
  const label = prompt('Name für dieses Lesezeichen:', defaultLabel);
  if (label === null) return;
  const bm = {
    id: 'bm_' + Date.now(),
    label: label.trim() || defaultLabel,
    pdfId: state.currentPdfId,
    pdfPage: state.currentPage,
    audioId: state.currentAudioId || null,
    audioTime: state.audio ? state.audio.currentTime : 0,
    createdAt: Date.now(),
  };
  const list = getBookmarks();
  list.unshift(bm);
  setBookmarks(list);
  renderBookmarks();
}

function deleteBookmark(id) {
  setBookmarks(getBookmarks().filter(b => b.id !== id));
  renderBookmarks();
}

async function loadBookmark(id) {
  const bm = getBookmarks().find(b => b.id === id);
  if (!bm) return;
  const pdfRec = await dbGet(bm.pdfId);
  if (!pdfRec) { alert('Das PDF zu diesem Lesezeichen existiert nicht mehr.'); return; }
  state.currentPdfId = bm.pdfId;
  await loadPdfFromBlob(pdfRec.blob, pdfRec.name);
  if (bm.audioId) {
    const audioRec = await dbGet(bm.audioId);
    if (audioRec) {
      state.currentAudioId = bm.audioId;
      saveAudioPosition(bm.audioId, bm.audioTime);
      loadAudioFromBlob(audioRec.blob);
    }
  }
  await renderLibrary();
  await updateAudioSelect();
  dropOverlay.classList.remove('visible');
  renderPage(bm.pdfPage || 0);
}

async function renderBookmarks() {
  const el = $('bookmarkList');
  if (!el) return;
  const list = getBookmarks();
  el.innerHTML = '';
  if (list.length === 0) {
    el.innerHTML = `<div class="lib-empty">Noch keine Lesezeichen — klicke oben auf 🔖, um die aktuelle Stelle zu speichern.</div>`;
    return;
  }
  // Resolve names from DB
  const items = await dbGetAll();
  const byId = Object.fromEntries(items.map(i => [i.id, i]));
  list.forEach(bm => {
    const item = document.createElement('div');
    item.className = 'lib-item';

    const name = document.createElement('span');
    name.className = 'lib-name';
    const pdfName = byId[bm.pdfId]?.name || '(PDF fehlt)';
    name.textContent = `${bm.label}  —  ${pdfName}`;
    item.appendChild(name);

    const meta = document.createElement('span');
    meta.className = 'lib-meta';
    meta.textContent = `S. ${bm.pdfPage + 1}` +
      (bm.audioId ? ` · ${formatTime(bm.audioTime)}` : '');
    item.appendChild(meta);

    const del = document.createElement('button');
    del.className = 'lib-del';
    del.textContent = '×';
    del.title = 'Lesezeichen löschen';
    del.addEventListener('click', e => {
      e.stopPropagation();
      deleteBookmark(bm.id);
    });
    item.appendChild(del);

    item.addEventListener('click', () => loadBookmark(bm.id));
    el.appendChild(item);
  });
}

// ─── File handling ───
const dropZone = $('dropZone');
const fileInput = $('fileInput');
const dropOverlay = $('dropOverlay');

dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => handleFiles(e.target.files));

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  handleFiles(e.dataTransfer.files);
});

function fileId(file) {
  return `${file.name}__${file.size}`;
}

async function handleFiles(files) {
  for (const file of files) {
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    const isAudio = file.type.startsWith('audio/') || file.type.startsWith('video/') ||
      /\.(mp3|wav|ogg|m4a|aac|flac|opus|webm|mp4|mkv|mov)$/i.test(file.name);
    if (!isPdf && !isAudio) continue;
    await dbPut({
      id: fileId(file),
      kind: isPdf ? 'pdf' : 'audio',
      name: file.name,
      blob: file,
      addedAt: Date.now(),
    });
  }
  await renderLibrary();
  await updateAudioSelect();
}

// ─── Library UI ───
async function renderLibrary() {
  const items = await dbGetAll();
  const pdfs = items.filter(i => i.kind === 'pdf');
  const audios = items.filter(i => i.kind === 'audio');

  renderLibList($('pdfList'), pdfs, 'pdf');
  renderLibList($('audioList'), audios, 'audio');
  updateStartButton();
}

function renderLibList(el, list, kind) {
  el.innerHTML = '';
  if (list.length === 0) {
    el.innerHTML = `<div class="lib-empty">Noch keine ${kind === 'pdf' ? 'PDFs' : 'Audio-Dateien'}</div>`;
    return;
  }
  list.forEach(rec => {
    const isSel = (kind === 'pdf' && rec.id === state.currentPdfId)
               || (kind === 'audio' && rec.id === state.currentAudioId);
    const item = document.createElement('div');
    item.className = 'lib-item' + (isSel ? ' selected' : '');

    const name = document.createElement('span');
    name.className = 'lib-name';
    name.textContent = rec.name;
    item.appendChild(name);

    if (kind === 'audio') {
      const pos = getAudioPosition(rec.id);
      if (pos > 0) {
        const meta = document.createElement('span');
        meta.className = 'lib-meta';
        meta.textContent = formatTime(pos);
        item.appendChild(meta);
      }
    }

    const del = document.createElement('button');
    del.className = 'lib-del';
    del.textContent = '×';
    del.title = 'Löschen';
    del.addEventListener('click', async e => {
      e.stopPropagation();
      await dbDelete(rec.id);
      if (kind === 'pdf' && state.currentPdfId === rec.id) state.currentPdfId = null;
      if (kind === 'audio' && state.currentAudioId === rec.id) state.currentAudioId = null;
      await renderLibrary();
      await updateAudioSelect();
    });
    item.appendChild(del);

    item.addEventListener('click', () => {
      kind === 'pdf' ? selectPdf(rec.id) : selectAudio(rec.id);
    });
    el.appendChild(item);
  });
}

function updateStartButton() {
  $('startBtn').classList.toggle('ready', state.pdfLoaded);
}

async function updateAudioSelect() {
  const items = await dbGetAll();
  const audios = items.filter(i => i.kind === 'audio');
  const sel = $('audioSelect');
  sel.innerHTML = '';
  if (audios.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Kein Audio';
    sel.appendChild(opt);
    return;
  }
  audios.forEach(a => {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = a.name;
    if (a.id === state.currentAudioId) opt.selected = true;
    sel.appendChild(opt);
  });
}

// ─── PDF loading ───
async function selectPdf(id) {
  const rec = await dbGet(id);
  if (!rec) return;
  state.currentPdfId = id;
  await loadPdfFromBlob(rec.blob, rec.name);
  await renderLibrary();
  saveSession();
}

async function loadPdfFromBlob(blob, name) {
  const arrayBuffer = await blob.arrayBuffer();
  state.pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  state.totalPages = state.pdf.numPages;
  const firstPage = await state.pdf.getPage(1);
  const vp = firstPage.getViewport({ scale: 1 });
  state.pageAspect = vp.width / vp.height;
  state.pdfLoaded = true;
  $('bookTitle').textContent = name.replace(/\.pdf$/i, '');
  $('bookAuthor').textContent = state.totalPages + ' Seiten';
  buildPageList();
  updateStartButton();
}

// ─── Audio loading ───
async function selectAudio(id) {
  const rec = await dbGet(id);
  if (!rec) return;
  if (state.audio && state.currentAudioId) {
    saveAudioPosition(state.currentAudioId, state.audio.currentTime);
  }
  state.currentAudioId = id;
  loadAudioFromBlob(rec.blob);
  await renderLibrary();
  await updateAudioSelect();
  saveSession();
}

function loadAudioFromBlob(blob) {
  if (state.audio) {
    state.audio.pause();
    try { URL.revokeObjectURL(state.audio.src); } catch {}
  }
  state.audio = new Audio(URL.createObjectURL(blob));
  state.audio.volume = 0.8;
  state.audio.playbackRate = state.speed;
  state.audioLoaded = true;
  state.playing = false;
  $('playPause').textContent = '▶';

  state.audio.addEventListener('loadedmetadata', () => {
    $('totalTime').textContent = formatTime(state.audio.duration);
    const saved = getAudioPosition(state.currentAudioId);
    if (saved > 0 && saved < state.audio.duration - 1) {
      state.audio.currentTime = saved;
    }
    updateProgress();
  });

  state.audio.addEventListener('timeupdate', () => {
    updateProgress();
    const now = Date.now();
    if (now - state._lastPosSave > 3000) {
      state._lastPosSave = now;
      saveAudioPosition(state.currentAudioId, state.audio.currentTime);
    }
  });

  state.audio.addEventListener('pause', () => {
    saveAudioPosition(state.currentAudioId, state.audio.currentTime);
  });

  state.audio.addEventListener('ended', () => {
    state.playing = false;
    $('playPause').textContent = '▶';
    saveAudioPosition(state.currentAudioId, 0);
  });
}

// ─── Start / Resume ───
function startReading() {
  if (!state.pdfLoaded) return;
  dropOverlay.classList.remove('visible');
  const session = loadSession();
  const same = session && session.pdfId === state.currentPdfId;
  renderPage(same ? (session.pdfPage || 0) : 0);
}

$('startBtn').addEventListener('click', startReading);

// ─── PDF Page Rendering (1:1 mit Original) ───
function fitPageBox() {
  const pageEl = $('pageContent');
  const container = pageEl.parentElement;
  if (!state.pageAspect || !container) return null;
  const labelH = 32;
  const availW = container.clientWidth;
  const availH = container.clientHeight - labelH;
  if (availW <= 0 || availH <= 0) return null;
  let w = availW;
  let h = availW / state.pageAspect;
  if (h > availH) { h = availH; w = availH * state.pageAspect; }
  pageEl.style.width = w + 'px';
  pageEl.style.height = h + 'px';
  pageEl.style.padding = '0';
  pageEl.style.margin = '0 auto';
  return { w, h };
}

async function renderPage(pdfIdx) {
  if (!state.pdf || pdfIdx < 0 || pdfIdx >= state.totalPages) return;
  state.currentPage = pdfIdx;
  const dims = fitPageBox();
  if (!dims) return;

  const page = await state.pdf.getPage(pdfIdx + 1);
  // Re-fit if aspect ratio of this specific page differs
  const baseVp = page.getViewport({ scale: 1 });
  state.pageAspect = baseVp.width / baseVp.height;
  const dims2 = fitPageBox() || dims;

  // Cap DPR — iOS Safari has hard canvas memory limits (~16MP on iPhone),
  // higher DPR can silently produce blank canvases on large PDFs.
  const rawDpr = window.devicePixelRatio || 1;
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) ||
                (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const dpr = Math.min(rawDpr, isIOS ? 2 : 3);
  let scale = (dims2.w / baseVp.width) * dpr;
  // Hard cap on total pixel area
  const maxPixels = isIOS ? 16777216 : 33554432; // 16MP / 32MP
  let pxW = baseVp.width * scale;
  let pxH = baseVp.height * scale;
  if (pxW * pxH > maxPixels) {
    const k = Math.sqrt(maxPixels / (pxW * pxH));
    scale *= k;
  }
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = dims2.w + 'px';
  canvas.style.height = dims2.h + 'px';
  canvas.style.display = 'block';

  const pageEl = $('pageContent');
  pageEl.innerHTML = '';
  pageEl.appendChild(canvas);

  if (state._renderTask) { try { state._renderTask.cancel(); } catch {} }
  state._renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport });
  try { await state._renderTask.promise; } catch {}

  const container = pageEl.parentElement;
  let label = container.querySelector('.page-number-ext');
  if (!label) {
    label = document.createElement('div');
    label.className = 'page-number page-number-ext';
    label.style.position = 'absolute';
    label.style.bottom = '6px';
    label.style.left = '0';
    label.style.right = '0';
    label.style.textAlign = 'center';
    container.appendChild(label);
  }
  label.textContent = `${pdfIdx + 1} / ${state.totalPages}`;

  document.querySelectorAll('.chapter-item').forEach((el, i) => {
    el.classList.toggle('active', i === pdfIdx);
  });

  $('prevPage').disabled = pdfIdx === 0;
  $('nextPage').disabled = pdfIdx === state.totalPages - 1;

  saveSession();
}

function nextScreen() {
  if (state.currentPage < state.totalPages - 1) renderPage(state.currentPage + 1);
}

function prevScreen() {
  if (state.currentPage > 0) renderPage(state.currentPage - 1);
}

function buildPageList() {
  const list = $('chapterList');
  list.innerHTML = '';
  for (let i = 0; i < state.totalPages; i++) {
    const el = document.createElement('div');
    el.className = 'chapter-item' + (i === state.currentPage ? ' active' : '');
    el.innerHTML = `<span class="chapter-num">${i + 1}</span><span>Seite ${i + 1}</span>`;
    el.addEventListener('click', () => renderPage(i));
    list.appendChild(el);
  }
}

// ─── Audio Controls ───
function togglePlay() {
  if (!state.audio) return;
  if (state.playing) {
    state.audio.pause();
    $('playPause').textContent = '▶';
  } else {
    state.audio.play();
    $('playPause').textContent = '⏸';
  }
  state.playing = !state.playing;
}

function updateProgress() {
  if (!state.audio || !state.audio.duration) return;
  const pct = (state.audio.currentTime / state.audio.duration) * 100;
  $('progressFill').style.width = pct + '%';
  $('currentTime').textContent = formatTime(state.audio.currentTime);
}

function formatTime(s) {
  if (!s || isNaN(s)) return '0:00';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  return `${m}:${String(sec).padStart(2,'0')}`;
}

$('playPause').addEventListener('click', togglePlay);
$('skipBack').addEventListener('click', () => { if (state.audio) state.audio.currentTime = Math.max(0, state.audio.currentTime - 15); });
$('skipForward').addEventListener('click', () => { if (state.audio) state.audio.currentTime = Math.min(state.audio.duration, state.audio.currentTime + 15); });

$('progressTrack').addEventListener('click', e => {
  if (!state.audio || !state.audio.duration) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const pct = (e.clientX - rect.left) / rect.width;
  state.audio.currentTime = pct * state.audio.duration;
});

$('volumeSlider').addEventListener('click', e => {
  if (!state.audio) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  state.audio.volume = pct;
  $('volumeFill').style.width = (pct * 100) + '%';
});

$('volumeBtn').addEventListener('click', () => {
  if (!state.audio) return;
  state.audio.muted = !state.audio.muted;
  $('volumeBtn').textContent = state.audio.muted ? '🔇' : '🔊';
});

$('speedBtn').addEventListener('click', () => {
  state.speedIndex = (state.speedIndex + 1) % state.speeds.length;
  state.speed = state.speeds[state.speedIndex];
  if (state.audio) state.audio.playbackRate = state.speed;
  $('speedBtn').textContent = state.speed + '×';
});

// ─── Audio selector ───
$('audioSelect').addEventListener('change', e => {
  if (e.target.value) selectAudio(e.target.value);
});

// ─── Library buttons ───
$('openLibrary').addEventListener('click', () => {
  dropOverlay.classList.add('visible');
  renderLibrary();
  renderBookmarks();
});

$('saveBookmark').addEventListener('click', addBookmark);
$('closeLibrary').addEventListener('click', () => {
  if (state.pdfLoaded) dropOverlay.classList.remove('visible');
});

$('prevPage').addEventListener('click', prevScreen);
$('nextPage').addEventListener('click', nextScreen);
$('toggleSidebar').addEventListener('click', () => {
  $('sidebar').classList.toggle('collapsed');
  if (state.pdfLoaded) requestAnimationFrame(() => renderPage(state.currentPage));
});

// ─── Keyboard Shortcuts ───
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyB') { e.preventDefault(); addBookmark(); return; }
  if (e.code === 'ArrowLeft') prevScreen();
  if (e.code === 'ArrowRight') nextScreen();
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
});

// ─── Touch swipe for page navigation ───
(() => {
  const area = document.querySelector('.reader-area');
  if (!area) return;
  let startX = 0, startY = 0, startT = 0, tracking = false;
  area.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) { tracking = false; return; }
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY; startT = Date.now();
    tracking = true;
  }, { passive: true });
  area.addEventListener('touchend', e => {
    if (!tracking) return;
    tracking = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    const dt = Date.now() - startT;
    if (dt > 600) return;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    if (dx < 0) nextScreen(); else prevScreen();
  }, { passive: true });
})();

// ─── Re-paginate on resize ───
let resizeTimer;
const handleResize = () => {
  if (!state.pdfLoaded) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    renderPage(state.currentPage);
  }, 150);
};
window.addEventListener('resize', handleResize);
window.addEventListener('orientationchange', handleResize);
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', handleResize);
}

// ─── Drag anywhere on page ───
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault();
  if (!dropOverlay.classList.contains('visible')) {
    handleFiles(e.dataTransfer.files);
  }
});

// ─── Save on exit ───
window.addEventListener('beforeunload', saveAll);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveAll();
});

// ─── Init ───
async function init() {
  await renderLibrary();
  await updateAudioSelect();
  renderBookmarks();
  const session = loadSession();
  if (session && session.pdfId) {
    const pdfRec = await dbGet(session.pdfId);
    if (pdfRec) {
      state.currentPdfId = session.pdfId;
      try { await loadPdfFromBlob(pdfRec.blob, pdfRec.name); } catch {}
      if (session.audioId) {
        const audioRec = await dbGet(session.audioId);
        if (audioRec) {
          state.currentAudioId = session.audioId;
          loadAudioFromBlob(audioRec.blob);
        }
      }
      await renderLibrary();
      await updateAudioSelect();
      const resumeBtn = $('resumeBtn');
      resumeBtn.style.display = 'inline-block';
      resumeBtn.onclick = () => {
        dropOverlay.classList.remove('visible');
        renderPage(session.pdfPage || 0);
      };
    }
  }
}
init();

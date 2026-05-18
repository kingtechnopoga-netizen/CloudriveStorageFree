/* ===========================================================
 * CloudVault — main.js
 * Real cloud upload + gallery powered by Puter.js v2
 * No backend, no DB, no API key.
 * =========================================================== */

// ---------- Configuration ----------
const STORAGE_FOLDER = 'cloudvault-uploads';

const ACCEPTED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/webm',
  'video/ogg'
]);

const ACCEPTED_EXT = new Set([
  'jpg', 'jpeg', 'png', 'webp', 'gif',
  'mp4', 'webm', 'ogg', 'ogv'
]);

// ---------- DOM refs ----------
const $ = (id) => document.getElementById(id);

const els = {
  fileInput: $('file-input'),
  dropzone: $('dropzone'),
  selectedList: $('selected-list'),
  uploadBtn: $('upload-btn'),
  clearBtn: $('clear-btn'),
  status: $('status'),
  statTotal: $('stat-total'),
  statImages: $('stat-images'),
  statVideos: $('stat-videos'),
  gallery: $('gallery'),
  galleryEmpty: $('gallery-empty'),
  galleryLoading: $('gallery-loading'),
  refreshBtn: $('refresh-btn'),
  newFolderBtn: $('new-folder-btn'),
  breadcrumbs: $('breadcrumbs'),
  authStatus: $('auth-status'),
  signInBtn: $('sign-in-btn')
};

// ---------- App state ----------
const state = {
  selected: [],            // File[]
  objectUrls: new Set(),   // track URLs to revoke
  cardBlobs: new Map(),    // path -> Blob (for instant Download)
  isUploading: false,
  isLoadingGallery: false,
  // Folder navigation: empty array = root (== STORAGE_FOLDER itself).
  // Each entry is a single folder name (already sanitized).
  currentPath: []
};

/** Build the absolute Puter path for the current folder. */
function currentFolderPath() {
  return [STORAGE_FOLDER, ...state.currentPath].join('/');
}

// ===========================================================
// Utilities
// ===========================================================

/** Format bytes to human-readable string. */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes === 0) return '0 B';
  const k = 1024;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  return `${(bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Detect file kind from MIME type and/or filename. */
function detectKind(mime, name) {
  const m = (mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  const ext = (name || '').toLowerCase().split('.').pop() || '';
  if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) return 'image';
  if (['mp4', 'webm', 'ogg', 'ogv'].includes(ext)) return 'video';
  return 'unknown';
}

/** Guess a mime type from filename extension (used when reading back files from Puter). */
function mimeFromName(name) {
  const ext = (name || '').toLowerCase().split('.').pop() || '';
  const map = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    mp4: 'video/mp4',
    webm: 'video/webm',
    ogg: 'video/ogg',
    ogv: 'video/ogg'
  };
  return map[ext] || '';
}

/** Is this file accepted? Allow either MIME match or known extension. */
function isAcceptedFile(file) {
  if (!file) return false;
  if (ACCEPTED_MIME.has((file.type || '').toLowerCase())) return true;
  const ext = (file.name || '').toLowerCase().split('.').pop() || '';
  return ACCEPTED_EXT.has(ext);
}

/** Sanitize a base filename: keep alnum/dot/dash/underscore. */
function sanitizeBaseName(name) {
  const base = (name || 'file').toString().split(/[\\/]/).pop();
  // Limit length and strip risky characters
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_');
  return cleaned.slice(0, 80) || 'file';
}

/** Build a unique remote filename: <ts>-<rand>-<original>. */
function buildUniqueName(originalName) {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}-${sanitizeBaseName(originalName)}`;
}

/**
 * Reverse of buildUniqueName(): strip the `<timestamp>-<rand>-` prefix
 * so the downloaded file uses the original name when possible.
 * If the prefix isn't found, return the name unchanged.
 */
function friendlyFilename(name) {
  if (!name) return 'download';
  // Match: 13+ digit timestamp, dash, 4-12 char alphanumeric token, dash, rest
  const m = /^(\d{10,})-([A-Za-z0-9]{4,12})-(.+)$/.exec(name);
  return m && m[3] ? m[3] : name;
}

/** Trigger a browser download for a Blob. */
function downloadBlob(blob, filename) {
  if (!(blob instanceof Blob)) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'download';
  // Append to body for Firefox compatibility
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after a tick so the download has a chance to start
  setTimeout(() => {
    try { URL.revokeObjectURL(url); } catch (_) { /* noop */ }
  }, 1500);
}

/** Set status message and visual state. */
function setStatus(message, kind = 'info') {
  if (!els.status) return;
  els.status.dataset.state = kind;
  els.status.textContent = '';
  if (kind === 'working') {
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    spinner.setAttribute('aria-hidden', 'true');
    els.status.appendChild(spinner);
  }
  const text = document.createElement('span');
  text.textContent = message;
  els.status.appendChild(text);
}

/** Get the human-readable error message from any thrown value. */
function readableError(err) {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  if (err.message) return err.message;
  if (err.error && err.error.message) return err.error.message;
  try { return JSON.stringify(err); } catch { return String(err); }
}

/** Detect "not found" style errors so we can show empty state instead of crash. */
function isNotFoundError(err) {
  if (!err) return false;
  const code = (err.code || err.error?.code || '').toString().toLowerCase();
  if (code.includes('not_found') || code.includes('subject_does_not_exist')) return true;
  const msg = readableError(err).toLowerCase();
  return (
    msg.includes('not found') ||
    msg.includes('does not exist') ||
    msg.includes('no such') ||
    msg.includes('enoent')
  );
}

/** Detect auth/permission errors. */
function isAuthError(err) {
  if (!err) return false;
  const code = (err.code || err.error?.code || '').toString().toLowerCase();
  if (code.includes('auth') || code.includes('permission') || code.includes('forbidden')) return true;
  const msg = readableError(err).toLowerCase();
  return msg.includes('sign in') || msg.includes('signed in') || msg.includes('unauthorized') || msg.includes('forbidden');
}

/** Wait until window.puter is available (Puter.js loaded). */
function waitForPuter(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (typeof window.puter !== 'undefined') return resolve(window.puter);
    const start = Date.now();
    const t = setInterval(() => {
      if (typeof window.puter !== 'undefined') {
        clearInterval(t);
        resolve(window.puter);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(t);
        reject(new Error('Puter.js failed to load. Please check your internet connection.'));
      }
    }, 100);
  });
}

/** Revoke and forget all tracked object URLs. */
function revokeAllObjectUrls() {
  for (const url of state.objectUrls) {
    try { URL.revokeObjectURL(url); } catch (_) { /* noop */ }
  }
  state.objectUrls.clear();
}

/**
 * Convert any value returned from puter.fs.read into a typed Blob.
 * Puter.js may return a Blob, a Response, a ReadableStream, an ArrayBuffer,
 * a Uint8Array, or a string depending on version and content type.
 */
async function normalizeToBlob(value, mime) {
  const type = mime || 'application/octet-stream';
  if (!value) throw new Error('Empty response');

  if (value instanceof Blob) {
    return value.type ? value : new Blob([value], { type });
  }
  if (typeof Response !== 'undefined' && value instanceof Response) {
    const b = await value.blob();
    return b.type ? b : new Blob([b], { type });
  }
  if (value instanceof ArrayBuffer) {
    return new Blob([value], { type });
  }
  if (ArrayBuffer.isView(value)) {
    return new Blob([value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)], { type });
  }
  if (value && typeof value.arrayBuffer === 'function') {
    const buf = await value.arrayBuffer();
    return new Blob([buf], { type });
  }
  if (typeof ReadableStream !== 'undefined' && value instanceof ReadableStream) {
    const reader = value.getReader();
    const chunks = [];
    /* eslint-disable no-await-in-loop */
    while (true) {
      const { value: chunk, done } = await reader.read();
      if (done) break;
      if (chunk) chunks.push(chunk);
    }
    /* eslint-enable no-await-in-loop */
    return new Blob(chunks, { type });
  }
  if (typeof value === 'string') {
    return new Blob([value], { type });
  }
  // Last resort: stringify (won't render media but won't crash)
  return new Blob([String(value)], { type });
}

// ===========================================================
// Auth helpers
// ===========================================================

async function isSignedInSafe() {
  try {
    if (window.puter?.auth?.isSignedIn) {
      return await Promise.resolve(window.puter.auth.isSignedIn());
    }
  } catch (_) { /* ignore */ }
  return false;
}

async function refreshAuthBadge() {
  const badge = els.authStatus;
  const signBtn = els.signInBtn;
  if (!badge) return;

  try {
    const signedIn = await isSignedInSafe();
    if (signedIn) {
      badge.textContent = 'Signed in';
      badge.dataset.state = 'signed-in';
      if (signBtn) signBtn.hidden = true;
    } else {
      badge.textContent = 'Not signed in';
      badge.dataset.state = 'signed-out';
      if (signBtn) signBtn.hidden = false;
    }
  } catch (err) {
    badge.textContent = 'Auth unavailable';
    badge.dataset.state = 'error';
    if (signBtn) signBtn.hidden = false;
  }
}

async function ensureSignedIn() {
  try {
    if (await isSignedInSafe()) return true;
    // Puter.js v2 exposes auth.signIn() which opens a popup.
    if (window.puter?.auth?.signIn) {
      await window.puter.auth.signIn();
    }
    const ok = await isSignedInSafe();
    await refreshAuthBadge();
    if (!ok) {
      setStatus('Please sign in to Puter to upload and manage your files.', 'warning');
    }
    return ok;
  } catch (err) {
    console.error('signIn failed:', err);
    setStatus('Please sign in to Puter to upload and manage your files.', 'warning');
    return false;
  }
}

// ===========================================================
// Selected files UI
// ===========================================================

function renderSelectedList() {
  els.selectedList.textContent = '';

  if (state.selected.length === 0) {
    els.uploadBtn.disabled = true;
    els.clearBtn.disabled = true;
    return;
  }

  els.uploadBtn.disabled = state.isUploading;
  els.clearBtn.disabled = state.isUploading;

  state.selected.forEach((file, idx) => {
    const item = document.createElement('div');
    item.className = 'selected-item';

    const icon = document.createElement('div');
    icon.className = 'si-icon';
    const kind = detectKind(file.type, file.name);
    icon.textContent = kind === 'image' ? 'IMG' : kind === 'video' ? 'VID' : 'FILE';
    item.appendChild(icon);

    const info = document.createElement('div');
    info.className = 'si-info';

    const nm = document.createElement('div');
    nm.className = 'si-name';
    nm.textContent = file.name;
    info.appendChild(nm);

    const meta = document.createElement('div');
    meta.className = 'si-meta';
    const typeStr = file.type || mimeFromName(file.name) || 'unknown';
    meta.textContent = `${typeStr} · ${formatBytes(file.size)}`;
    info.appendChild(meta);

    item.appendChild(info);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'si-remove';
    remove.setAttribute('aria-label', `Remove ${file.name}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      if (state.isUploading) return;
      state.selected.splice(idx, 1);
      renderSelectedList();
      if (state.selected.length === 0) setStatus('Ready', 'info');
    });
    item.appendChild(remove);

    els.selectedList.appendChild(item);
  });
}

async function addSelectedFiles(fileList) {
  if (!fileList || fileList.length === 0) return;

  const files = Array.from(fileList);
  const accepted = [];
  const rejected = [];

  for (const f of files) {
    if (isAcceptedFile(f)) accepted.push(f);
    else rejected.push(f);
  }

  // Avoid duplicate (name + size) pairs.
  // IMPORTANT: We read each file into an ArrayBuffer immediately while
  // the File handle is still valid. On some phones (especially Android),
  // the File reference becomes unreadable after the input is reset or
  // after a delay — causing "NotReadableError: permission problems".
  for (const f of accepted) {
    const dup = state.selected.some(
      (s) => s.name === f.name && s.size === f.size && s.lastModified === f.lastModified
    );
    if (!dup) {
      // Pre-read file bytes while handle is fresh.
      try {
        const buf = await f.arrayBuffer();
        const mime = f.type || mimeFromName(f.name) || 'application/octet-stream';
        const blob = new Blob([buf], { type: mime });
        // Reconstruct as a File with the same metadata but backed by in-memory data.
        let stableFile;
        try {
          stableFile = new File([blob], f.name, {
            type: mime,
            lastModified: f.lastModified || Date.now()
          });
        } catch (_) {
          // Fallback for browsers that don't support File constructor.
          stableFile = blob;
          stableFile.name = f.name;
          stableFile.lastModified = f.lastModified || Date.now();
        }
        state.selected.push(stableFile);
      } catch (readErr) {
        console.warn('Could not pre-read file:', f.name, readErr);
        // Still push original — upload will attempt it anyway.
        state.selected.push(f);
      }
    }
  }

  renderSelectedList();

  if (accepted.length === 0 && rejected.length > 0) {
    setStatus(
      `Skipped ${rejected.length} unsupported file${rejected.length === 1 ? '' : 's'}. Only JPEG, PNG, WEBP, GIF, MP4, WEBM, OGG are allowed.`,
      'warning'
    );
  } else if (rejected.length > 0) {
    setStatus(
      `Added ${accepted.length} file${accepted.length === 1 ? '' : 's'}. Skipped ${rejected.length} unsupported file${rejected.length === 1 ? '' : 's'}.`,
      'warning'
    );
  } else {
    setStatus(`Selected ${state.selected.length} file${state.selected.length === 1 ? '' : 's'}. Ready to upload.`, 'info');
  }
}

function clearSelection() {
  state.selected = [];
  els.fileInput.value = '';
  renderSelectedList();
  setStatus('Ready', 'info');
}

// ===========================================================
// Upload (robust, multi-strategy)
// ===========================================================

/**
 * Try to ensure the storage folder exists. If mkdir is unavailable or
 * the folder already exists, silently continue. Failures here are
 * non-fatal because both fs.write({createMissingParents:true}) and
 * fs.upload() will create the folder themselves on most builds.
 */
async function ensureStorageFolder() {
  try {
    if (window.puter?.fs?.mkdir) {
      // Always make sure the root storage folder exists, plus the
      // current sub-folder (if any). createMissingParents handles depth.
      const target = currentFolderPath();
      await window.puter.fs.mkdir(target, {
        createMissingParents: true,
        overwrite: false,
        dedupeName: false
      });
    }
  } catch (_) { /* folder probably already exists — that's fine */ }
}

/**
 * Upload a single browser File using whichever Puter.js API works.
 *
 * Strategy order (each is wrapped in try/catch):
 *   1. puter.fs.upload([file], parentDir)           ← preferred for File objects
 *   2. puter.fs.write(fullPath, file, {createMissingParents:true, overwrite:false})
 *   3. puter.fs.write(fullPath, blob, {createMissingParents:true, overwrite:false})
 *      (rebuild the file as a Blob with explicit MIME)
 *   4. puter.fs.write(fullPath, arrayBuffer, {createMissingParents:true, overwrite:false})
 *
 * Returns the resulting remote path (best effort) or throws the last error.
 */
async function uploadOneFile(file, remoteName) {
  const parentDir = currentFolderPath();
  const remotePath = `${parentDir}/${remoteName}`;
  const errors = [];

  // ---------- Strategy 1: puter.fs.upload ----------
  // puter.fs.upload(items, dirPath, options) is the documented API for
  // browser File / FileList uploads. We rename the File so Puter saves it
  // under our unique name (avoids conflicts) and keep it inside our folder.
  try {
    if (window.puter?.fs?.upload) {
      // Re-wrap File with the unique name so the saved filename is unique.
      let renamed;
      try {
        renamed = new File([file], remoteName, {
          type: file.type || mimeFromName(file.name) || 'application/octet-stream',
          lastModified: file.lastModified || Date.now()
        });
      } catch (_) {
        // Some very old browsers don't allow `new File(...)` — fall back to original.
        renamed = file;
      }

      const result = await window.puter.fs.upload([renamed], parentDir, {
        createMissingParents: true,
        overwrite: false,
        dedupeName: true
      });

      // Best-effort: return the path Puter reports (varies by build).
      const first = Array.isArray(result) ? result[0] : result;
      if (first && (first.path || first.name)) {
        return first.path || `${parentDir}/${first.name}`;
      }
      return remotePath;
    }
  } catch (err) {
    errors.push(['upload', err]);
    console.warn('puter.fs.upload failed, falling back:', err);
  }

  // ---------- Strategy 2: puter.fs.write(path, file) ----------
  try {
    if (window.puter?.fs?.write) {
      await window.puter.fs.write(remotePath, file, {
        createMissingParents: true,
        overwrite: false,
        dedupeName: true
      });
      return remotePath;
    }
  } catch (err) {
    errors.push(['write-file', err]);
    console.warn('puter.fs.write(file) failed, falling back:', err);
  }

  // ---------- Strategy 3: puter.fs.write(path, blob) ----------
  try {
    if (window.puter?.fs?.write) {
      const mime = file.type || mimeFromName(file.name) || 'application/octet-stream';
      const blob = new Blob([file], { type: mime });
      await window.puter.fs.write(remotePath, blob, {
        createMissingParents: true,
        overwrite: false,
        dedupeName: true
      });
      return remotePath;
    }
  } catch (err) {
    errors.push(['write-blob', err]);
    console.warn('puter.fs.write(blob) failed, falling back:', err);
  }

  // ---------- Strategy 4: puter.fs.write(path, arrayBuffer) ----------
  try {
    if (window.puter?.fs?.write && typeof file.arrayBuffer === 'function') {
      const buf = await file.arrayBuffer();
      await window.puter.fs.write(remotePath, buf, {
        createMissingParents: true,
        overwrite: false,
        dedupeName: true
      });
      return remotePath;
    }
  } catch (err) {
    errors.push(['write-buffer', err]);
    console.warn('puter.fs.write(arrayBuffer) failed, falling back:', err);
  }

  // All strategies failed — throw the last (most informative) error.
  const last = errors[errors.length - 1]?.[1];
  throw last || new Error('Upload failed: no compatible Puter.js API found.');
}

async function uploadAll() {
  if (state.isUploading) return;
  if (state.selected.length === 0) {
    setStatus('Please choose at least one file.', 'warning');
    return;
  }

  // Make sure Puter.js is actually loaded (CDN can be flaky on slow networks).
  try {
    await waitForPuter();
  } catch (err) {
    setStatus(readableError(err), 'error');
    return;
  }

  // Ensure signed in (so Puter can write to user storage)
  setStatus('Checking files', 'working');
  const ok = await ensureSignedIn();
  if (!ok) return;

  // Best-effort: pre-create folder.
  await ensureStorageFolder();

  state.isUploading = true;
  els.uploadBtn.classList.add('is-loading');
  els.uploadBtn.disabled = true;
  els.clearBtn.disabled = true;
  els.fileInput.disabled = true;

  const total = state.selected.length;
  let succeeded = 0;
  const failed = []; // [{ file, error }]

  for (let i = 0; i < total; i++) {
    const file = state.selected[i];
    setStatus(`Uploading ${i + 1} of ${total}: ${file.name}`, 'working');

    try {
      const remoteName = buildUniqueName(file.name);
      await uploadOneFile(file, remoteName);
      succeeded++;
    } catch (err) {
      console.error('Upload failed for', file.name, err);
      failed.push({ file, error: err });

      if (isAuthError(err)) {
        setStatus('Please sign in to Puter to upload and manage your files.', 'warning');
        await refreshAuthBadge();
        break;
      }
    }
  }

  state.isUploading = false;
  els.uploadBtn.classList.remove('is-loading');
  els.fileInput.disabled = false;

  if (failed.length === 0 && succeeded > 0) {
    setStatus(
      `Upload complete — ${succeeded} file${succeeded === 1 ? '' : 's'} saved to cloud.`,
      'success'
    );
    state.selected = [];
    els.fileInput.value = '';
    renderSelectedList();
  } else if (succeeded > 0 && failed.length > 0) {
    const reason = readableError(failed[0].error);
    setStatus(
      `Uploaded ${succeeded} of ${total}. Upload failed: ${reason}`,
      'warning'
    );
    // Keep only the failed files for retry
    const failedNames = new Set(failed.map((f) => f.file.name));
    state.selected = state.selected.filter((f) => failedNames.has(f.name));
    renderSelectedList();
  } else {
    const reason = failed[0] ? readableError(failed[0].error) : 'no files were uploaded.';
    setStatus(`Upload failed: ${reason}`, 'error');
    renderSelectedList();
  }

  // Reload gallery from real cloud
  await loadGallery();
}

// ===========================================================
// Gallery
// ===========================================================

function showLoading(show) {
  if (!els.galleryLoading) return;
  els.galleryLoading.hidden = !show;
}

function showEmpty(show) {
  if (!els.galleryEmpty) return;
  els.galleryEmpty.hidden = !show;
}

function clearGalleryDom() {
  els.gallery.textContent = '';
  revokeAllObjectUrls();
  state.cardBlobs.clear();
}

function updateStats(entries) {
  let images = 0;
  let videos = 0;
  for (const e of entries) {
    const kind = detectKind(mimeFromName(e.name), e.name);
    if (kind === 'image') images++;
    else if (kind === 'video') videos++;
  }
  els.statTotal.textContent = String(entries.length);
  els.statImages.textContent = String(images);
  els.statVideos.textContent = String(videos);
}

async function loadGallery() {
  if (state.isLoadingGallery) return;
  state.isLoadingGallery = true;

  clearGalleryDom();
  showEmpty(false);
  showLoading(true);
  renderBreadcrumbs();

  try {
    await waitForPuter();
  } catch (err) {
    showLoading(false);
    state.isLoadingGallery = false;
    setStatus(readableError(err), 'error');
    return;
  }

  const folderPath = currentFolderPath();
  let entries = [];
  try {
    const result = await window.puter.fs.readdir(folderPath);
    entries = Array.isArray(result) ? result : [];
  } catch (err) {
    showLoading(false);
    state.isLoadingGallery = false;

    if (isNotFoundError(err)) {
      // Folder doesn't exist yet — show beautiful empty state
      updateStats([]);
      showEmpty(true);
      return;
    }
    if (isAuthError(err)) {
      updateStats([]);
      showEmpty(true);
      setStatus('Please sign in to Puter to upload and manage your files.', 'warning');
      await refreshAuthBadge();
      return;
    }
    console.error('readdir failed:', err);
    updateStats([]);
    showEmpty(true);
    setStatus(`Could not load library: ${readableError(err)}`, 'error');
    return;
  }

  // Split entries into folders and supported media files.
  const folderEntries = entries.filter((e) => {
    if (!e || !e.name) return false;
    return e.is_dir === true || e.isDirectory === true;
  });

  const fileEntries = entries.filter((e) => {
    if (!e || !e.name) return false;
    if (e.is_dir || e.isDirectory) return false;
    const kind = detectKind(mimeFromName(e.name), e.name);
    return kind === 'image' || kind === 'video';
  });

  // Folders alphabetically; files newest-first using timestamp prefix
  folderEntries.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  fileEntries.sort((a, b) => {
    const ta = parseInt((a.name || '').split('-')[0], 10);
    const tb = parseInt((b.name || '').split('-')[0], 10);
    if (Number.isFinite(ta) && Number.isFinite(tb)) return tb - ta;
    const ma = a.modified || a.modified_at || a.mtime || 0;
    const mb = b.modified || b.modified_at || b.mtime || 0;
    return mb - ma;
  });

  updateStats(fileEntries);
  showLoading(false);

  if (folderEntries.length === 0 && fileEntries.length === 0) {
    showEmpty(true);
    state.isLoadingGallery = false;
    return;
  }

  // Render folders first, then media files.
  for (const entry of folderEntries) {
    els.gallery.appendChild(buildFolderCard(entry));
  }
  for (const entry of fileEntries) {
    els.gallery.appendChild(buildGalleryCard(entry));
  }

  // Hydrate media previews in parallel; folder cards don't need hydration.
  await Promise.all(
    fileEntries.map((entry) => hydrateCardMedia(entry))
  );

  state.isLoadingGallery = false;
}

function buildGalleryCard(entry) {
  const path = entry.path || `${currentFolderPath()}/${entry.name}`;
  const kind = detectKind(mimeFromName(entry.name), entry.name);
  const mime = mimeFromName(entry.name) || (kind === 'image' ? 'image/*' : kind === 'video' ? 'video/*' : 'application/octet-stream');

  const card = document.createElement('article');
  card.className = 'gallery-card';
  card.dataset.path = path;
  card.dataset.kind = kind;

  const media = document.createElement('div');
  media.className = 'gc-media';
  card.appendChild(media);

  const badge = document.createElement('span');
  badge.className = 'gc-badge';
  badge.dataset.kind = kind;
  badge.textContent = kind === 'image' ? 'Image' : kind === 'video' ? 'Video' : 'File';
  media.appendChild(badge);

  const loadingNode = document.createElement('div');
  loadingNode.className = 'gc-loading';
  const spinner = document.createElement('span');
  spinner.className = 'spinner';
  spinner.setAttribute('aria-hidden', 'true');
  loadingNode.appendChild(spinner);
  const lbl = document.createElement('span');
  lbl.textContent = 'Loading…';
  loadingNode.appendChild(lbl);
  media.appendChild(loadingNode);

  const info = document.createElement('div');
  info.className = 'gc-info';

  const nm = document.createElement('div');
  nm.className = 'gc-name';
  nm.textContent = friendlyFilename(entry.name);
  nm.title = entry.name;
  info.appendChild(nm);

  const meta = document.createElement('div');
  meta.className = 'gc-meta';
  meta.textContent = `${mime}`;
  info.appendChild(meta);

  const pathEl = document.createElement('div');
  pathEl.className = 'gc-meta';
  pathEl.textContent = path;
  info.appendChild(pathEl);

  card.appendChild(info);

  const actions = document.createElement('div');
  actions.className = 'gc-actions';

  const dlBtn = document.createElement('button');
  dlBtn.type = 'button';
  dlBtn.className = 'btn btn-primary';
  dlBtn.textContent = 'Download';
  dlBtn.addEventListener('click', () => handleDownload(entry, card));
  actions.appendChild(dlBtn);

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'btn btn-danger';
  delBtn.textContent = 'Delete';
  delBtn.addEventListener('click', () => handleDelete(entry, card));
  actions.appendChild(delBtn);

  card.appendChild(actions);

  return card;
}

async function hydrateCardMedia(entry) {
  const path = entry.path || `${currentFolderPath()}/${entry.name}`;
  const card = els.gallery.querySelector(`.gallery-card[data-path="${cssEscape(path)}"]`);
  if (!card) return;

  const media = card.querySelector('.gc-media');
  if (!media) return;

  const kind = detectKind(mimeFromName(entry.name), entry.name);
  const mime = mimeFromName(entry.name) || (kind === 'image' ? 'image/*' : kind === 'video' ? 'video/*' : 'application/octet-stream');

  try {
    // Real cloud read — may return Blob, Response, ReadableStream or ArrayBuffer
    // depending on the Puter.js build. Normalise to a typed Blob.
    const raw = await window.puter.fs.read(path);
    const usable = await normalizeToBlob(raw, mime);
    if (!(usable instanceof Blob)) throw new Error('Unsupported file payload');

    // Cache for instant Download.
    state.cardBlobs.set(path, usable);

    const url = URL.createObjectURL(usable);
    state.objectUrls.add(url);

    // Remove loading overlay
    const loadingNode = media.querySelector('.gc-loading');
    if (loadingNode) loadingNode.remove();

    if (kind === 'image') {
      const img = document.createElement('img');
      img.alt = entry.name;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.src = url;
      media.appendChild(img);
    } else if (kind === 'video') {
      const video = document.createElement('video');
      video.controls = true;
      video.preload = 'metadata';
      video.playsInline = true;
      video.src = url;
      media.appendChild(video);
    } else {
      const span = document.createElement('span');
      span.textContent = 'Preview unavailable';
      span.style.color = 'var(--text-muted)';
      span.style.fontSize = '0.85rem';
      media.appendChild(span);
    }
  } catch (err) {
    console.error('read failed for', path, err);
    const loadingNode = media.querySelector('.gc-loading');
    if (loadingNode) {
      loadingNode.textContent = 'Preview unavailable';
    }
  }
}

/** Minimal CSS.escape fallback for older browsers. */
function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_\u00A0-\uFFFF-]/g, (ch) => `\\${ch}`);
}

// ===========================================================
// Folders
// ===========================================================

/** Sanitize a user-provided folder name. */
function sanitizeFolderName(raw) {
  if (!raw) return '';
  // Trim, collapse whitespace, strip path separators and risky chars,
  // limit length, and forbid leading dots so users can't escape the folder.
  const cleaned = raw
    .toString()
    .trim()
    .replace(/[\\/]+/g, '_')
    .replace(/[^A-Za-z0-9 ._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 60);
  return cleaned;
}

/** Render the breadcrumb trail for the current path. */
function renderBreadcrumbs() {
  const wrap = els.breadcrumbs;
  if (!wrap) return;
  wrap.textContent = '';

  // "Home" crumb (root of cloudvault-uploads)
  const home = document.createElement('button');
  home.type = 'button';
  home.className = 'crumb';
  home.setAttribute('aria-label', 'Go to library root');

  const homeIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  homeIcon.setAttribute('viewBox', '0 0 24 24');
  homeIcon.setAttribute('fill', 'none');
  homeIcon.innerHTML =
    '<path d="M3 11l9-8 9 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>';
  home.appendChild(homeIcon);

  const homeLabel = document.createElement('span');
  homeLabel.textContent = 'Library';
  home.appendChild(homeLabel);

  if (state.currentPath.length === 0) {
    home.classList.add('is-current');
    home.disabled = true;
  } else {
    home.addEventListener('click', () => navigateTo([]));
  }
  wrap.appendChild(home);

  // Each folder segment in the path
  state.currentPath.forEach((segment, idx) => {
    const sep = document.createElement('span');
    sep.className = 'crumb-sep';
    sep.setAttribute('aria-hidden', 'true');
    sep.textContent = '›';
    wrap.appendChild(sep);

    const isLast = idx === state.currentPath.length - 1;
    const c = document.createElement('button');
    c.type = 'button';
    c.className = 'crumb' + (isLast ? ' is-current' : '');
    c.textContent = segment;
    c.title = segment;
    if (isLast) {
      c.disabled = true;
    } else {
      c.addEventListener('click', () => navigateTo(state.currentPath.slice(0, idx + 1)));
    }
    wrap.appendChild(c);
  });
}

/** Navigate to a new folder path (array of segments). */
function navigateTo(pathSegments) {
  state.currentPath = Array.isArray(pathSegments) ? pathSegments.slice() : [];
  // Reset selected files so users don't accidentally upload elsewhere.
  loadGallery();
}

/** Build a folder card (clickable to open). */
function buildFolderCard(entry) {
  const path = entry.path || `${currentFolderPath()}/${entry.name}`;

  const card = document.createElement('article');
  card.className = 'gallery-card folder-card';
  card.dataset.path = path;
  card.dataset.kind = 'folder';
  card.setAttribute('role', 'button');
  card.setAttribute('tabindex', '0');
  card.setAttribute('aria-label', `Open folder ${entry.name}`);

  const media = document.createElement('div');
  media.className = 'gc-media';
  card.appendChild(media);

  const badge = document.createElement('span');
  badge.className = 'gc-badge';
  badge.dataset.kind = 'folder';
  badge.textContent = 'Folder';
  media.appendChild(badge);

  const icon = document.createElement('div');
  icon.className = 'folder-icon';
  icon.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.innerHTML =
    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>';
  icon.appendChild(svg);
  media.appendChild(icon);

  const info = document.createElement('div');
  info.className = 'gc-info';

  const nm = document.createElement('div');
  nm.className = 'gc-name';
  nm.textContent = entry.name;
  info.appendChild(nm);

  const meta = document.createElement('div');
  meta.className = 'gc-meta';
  meta.textContent = 'Folder';
  info.appendChild(meta);

  const pathEl = document.createElement('div');
  pathEl.className = 'gc-meta';
  pathEl.textContent = path;
  info.appendChild(pathEl);

  card.appendChild(info);

  const actions = document.createElement('div');
  actions.className = 'gc-actions';

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'btn btn-primary';
  openBtn.textContent = 'Open';
  openBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    handleOpenFolder(entry);
  });
  actions.appendChild(openBtn);

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'btn btn-danger';
  delBtn.textContent = 'Delete';
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    handleDeleteFolder(entry, card);
  });
  actions.appendChild(delBtn);

  card.appendChild(actions);

  // Whole-card click / keyboard opens the folder (except clicks on buttons).
  card.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    handleOpenFolder(entry);
  });
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleOpenFolder(entry);
    }
  });

  return card;
}

/** Open a sub-folder. */
function handleOpenFolder(entry) {
  if (!entry || !entry.name) return;
  navigateTo([...state.currentPath, entry.name]);
}

/** Create a new folder inside the current folder. */
async function handleNewFolder() {
  try {
    await waitForPuter();
  } catch (err) {
    setStatus(readableError(err), 'error');
    return;
  }

  const ok = await ensureSignedIn();
  if (!ok) return;

  const raw = window.prompt('Folder name', '');
  if (raw === null) return; // user cancelled

  const name = sanitizeFolderName(raw);
  if (!name) {
    setStatus('Please enter a valid folder name.', 'warning');
    return;
  }

  const target = `${currentFolderPath()}/${name}`;
  setStatus(`Creating folder ${name}…`, 'working');

  try {
    if (!window.puter?.fs?.mkdir) {
      throw new Error('Puter mkdir is not available.');
    }
    await window.puter.fs.mkdir(target, {
      createMissingParents: true,
      overwrite: false,
      dedupeName: true
    });
    setStatus(`Folder "${name}" created.`, 'success');
    await loadGallery();
  } catch (err) {
    console.error('mkdir failed:', err);
    if (isAuthError(err)) {
      setStatus('Please sign in to Puter to upload and manage your files.', 'warning');
    } else {
      setStatus(`Could not create folder: ${readableError(err)}`, 'error');
    }
  }
}

/** Delete a sub-folder (with confirmation; recursive when supported). */
async function handleDeleteFolder(entry, card) {
  const path = entry.path || `${currentFolderPath()}/${entry.name}`;
  const confirmed = window.confirm(
    `Delete folder "${entry.name}" and everything inside it?\n\nThis cannot be undone.`
  );
  if (!confirmed) return;

  card.querySelectorAll('button').forEach((b) => (b.disabled = true));
  setStatus(`Deleting folder ${entry.name}…`, 'working');

  try {
    // Prefer recursive delete; some Puter.js builds use { recursive: true }.
    await window.puter.fs.delete(path, { recursive: true });
    setStatus('Folder deleted.', 'success');
    await loadGallery();
  } catch (err) {
    console.error('folder delete failed:', err);
    if (isAuthError(err)) {
      setStatus('Please sign in to Puter to upload and manage your files.', 'warning');
    } else {
      setStatus(`Delete failed: ${readableError(err)}`, 'error');
    }
    card.querySelectorAll('button').forEach((b) => (b.disabled = false));
  }
}

// ===========================================================
// Download
// ===========================================================

async function handleDownload(entry, card) {
  const path = entry.path || `${currentFolderPath()}/${entry.name}`;
  const friendly = friendlyFilename(entry.name);
  const mime = mimeFromName(entry.name) || 'application/octet-stream';

  // Fast path: the gallery already loaded this blob for the preview.
  const cached = state.cardBlobs.get(path);
  if (cached instanceof Blob) {
    try {
      downloadBlob(cached, friendly);
      setStatus(`Downloaded ${friendly}.`, 'success');
      return;
    } catch (err) {
      console.warn('Cached download failed, will re-fetch:', err);
    }
  }

  // Slow path: fetch from Puter and download.
  const dlBtn = card?.querySelector('.gc-actions .btn-primary');
  if (dlBtn) {
    dlBtn.classList.add('is-loading');
    dlBtn.disabled = true;
  }
  setStatus(`Preparing download for ${friendly}…`, 'working');

  try {
    const raw = await window.puter.fs.read(path);
    const blob = await normalizeToBlob(raw, mime);
    if (!(blob instanceof Blob)) throw new Error('Unsupported file payload');
    state.cardBlobs.set(path, blob);
    downloadBlob(blob, friendly);
    setStatus(`Downloaded ${friendly}.`, 'success');
  } catch (err) {
    console.error('Download failed:', err);
    if (isAuthError(err)) {
      setStatus('Please sign in to Puter to upload and manage your files.', 'warning');
    } else {
      setStatus(`Download failed: ${readableError(err)}`, 'error');
    }
  } finally {
    if (dlBtn) {
      dlBtn.classList.remove('is-loading');
      dlBtn.disabled = false;
    }
  }
}

// ===========================================================
// Delete
// ===========================================================

async function handleDelete(entry, card) {
  const path = entry.path || `${currentFolderPath()}/${entry.name}`;
  const confirmed = window.confirm(`Delete this file?\n\n${entry.name}\n\nThis cannot be undone.`);
  if (!confirmed) return;

  // Disable card actions during delete
  card.querySelectorAll('button').forEach((b) => (b.disabled = true));
  setStatus(`Deleting ${entry.name}…`, 'working');

  try {
    await window.puter.fs.delete(path);
    setStatus('File deleted.', 'success');
    await loadGallery();
  } catch (err) {
    console.error('delete failed:', err);
    if (isAuthError(err)) {
      setStatus('Please sign in to Puter to upload and manage your files.', 'warning');
    } else {
      setStatus(`Delete failed: ${readableError(err)}`, 'error');
    }
    card.querySelectorAll('button').forEach((b) => (b.disabled = false));
  }
}

// ===========================================================
// Drag & drop
// ===========================================================

function initDragAndDrop() {
  const dz = els.dropzone;
  if (!dz) return;

  ['dragenter', 'dragover'].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dz.classList.add('is-drag');
    })
  );

  ['dragleave', 'drop'].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dz.classList.remove('is-drag');
    })
  );

  dz.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    if (!dt || !dt.files || dt.files.length === 0) return;
    addSelectedFiles(dt.files);
  });

  // Prevent the browser from navigating when a file is dropped outside dz
  ['dragover', 'drop'].forEach((ev) =>
    window.addEventListener(ev, (e) => {
      if (e.target === dz || dz.contains(e.target)) return;
      e.preventDefault();
    })
  );
}

// ===========================================================
// Wire up events
// ===========================================================

function bindEvents() {
  // File picker
  els.fileInput.addEventListener('change', (e) => {
    const files = e.target.files;
    // Handle canceled file picker safely (no files)
    if (!files || files.length === 0) return;
    addSelectedFiles(files);
    // Reset input so the same file can be reselected after removal
    els.fileInput.value = '';
  });

  // Upload
  els.uploadBtn.addEventListener('click', () => {
    uploadAll().catch((err) => {
      console.error(err);
      setStatus(`Upload failed: ${readableError(err)}`, 'error');
      state.isUploading = false;
      els.uploadBtn.classList.remove('is-loading');
    });
  });

  // Clear
  els.clearBtn.addEventListener('click', () => {
    if (state.isUploading) return;
    clearSelection();
  });

  // Refresh gallery
  els.refreshBtn.addEventListener('click', () => {
    loadGallery();
  });

  // New folder
  if (els.newFolderBtn) {
    els.newFolderBtn.addEventListener('click', () => {
      handleNewFolder();
    });
  }

  // Sign in button
  if (els.signInBtn) {
    els.signInBtn.addEventListener('click', async () => {
      const ok = await ensureSignedIn();
      if (ok) loadGallery();
    });
  }

  // Cleanup on unload
  window.addEventListener('beforeunload', () => revokeAllObjectUrls());
}

// ===========================================================
// Boot
// ===========================================================

async function boot() {
  setStatus('Ready', 'info');
  bindEvents();
  initDragAndDrop();

  try {
    await waitForPuter();
  } catch (err) {
    if (els.authStatus) {
      els.authStatus.textContent = 'Puter unavailable';
      els.authStatus.dataset.state = 'error';
    }
    setStatus(readableError(err), 'error');
    return;
  }

  await refreshAuthBadge();
  await loadGallery();
}

// Run
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

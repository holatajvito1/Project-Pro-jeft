/* Projector Mapper — browser-based projection mapping.
 * The editor window and the output window share this file. The output window
 * (index.html?output) only renders; the editor sends it state over a BroadcastChannel.
 * All shape coordinates are normalized (0..1) so any output resolution works. */
'use strict';

const isOutput = new URLSearchParams(location.search).has('output');
const chan = 'BroadcastChannel' in window ? new BroadcastChannel('projector-mapper') : null;
const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const fx = document.createElement('canvas');      // offscreen buffer for soft edges
const fxCtx = fx.getContext('2d');
const $ = (id) => document.getElementById(id);

const EFFECTS = {
  solid: 'Solid color', pulse: 'Pulse', strobe: 'Strobe', fade: 'Fade A ↔ B',
  gradient: 'Rotating gradient', rainbow: 'Rainbow', chase: 'Chase stripes', wipe: 'Wipe',
  sparkle: 'Sparkle', outline: 'Neon outline', media: 'Image / video', grid: 'Alignment grid',
};
const AUTO_EFFECTS = ['solid', 'pulse', 'strobe', 'fade', 'gradient', 'rainbow', 'chase', 'wipe', 'sparkle', 'outline'];

let state = { shapes: [], master: 1, bpm: 120, beatOrigin: Date.now(), blackout: false, testGrid: false };
const media = {};            // id -> { id, name, type, url, el }
let audioLevel = 0;

/* ---------------- helpers ---------------- */
const uid = () => Math.random().toString(36).slice(2, 9);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function mix(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  return `rgb(${A.map((v, i) => Math.round(v + (B[i] - v) * t)).join(',')})`;
}
function hslHex(h, s, l) {
  s /= 100; l /= 100;
  const f = (n) => { const k = (n + h / 30) % 12; const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0'); };
  return `#${f(0)}${f(8)}${f(4)}`;
}
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function bbox(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
function tracePath(c, pts) { c.beginPath(); pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.closePath(); }
function pointInPoly([px, py], pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function distToSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/* ---------------- media ---------------- */
function ensureMediaEl(m) {
  if (m.el) return m.el;
  if (m.type === 'video') {
    const v = document.createElement('video');
    Object.assign(v, { src: m.url, loop: true, muted: true, playsInline: true, autoplay: true });
    v.play().catch(() => {});
    m.el = v;
  } else {
    const img = new Image(); img.src = m.url; m.el = img;
  }
  return m.el;
}
function mediaReady(el) {
  return el instanceof HTMLVideoElement ? el.readyState >= 2 : el.complete && el.naturalWidth > 0;
}

/* ---------------- rendering ---------------- */
function resize() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  if (fx.width !== w || fx.height !== h) { fx.width = w; fx.height = h; }
}

function paint(c, s, bb, b, pts, W) {
  const { x, y, w, h } = bb;
  const A = s.colorA, B = s.colorB;
  const f = ((b % 1) + 1) % 1;                     // position within the current beat
  const fill = (style) => { c.fillStyle = style; c.fillRect(x, y, w, h); };
  switch (s.effect) {
    case 'solid': fill(A); break;
    case 'pulse': c.globalAlpha *= 0.5 + 0.5 * Math.cos(f * 2 * Math.PI); fill(A); break;
    case 'strobe': if (f < 0.12) fill(A); break;
    case 'fade': fill(mix(A, B, 0.5 - 0.5 * Math.cos(b * Math.PI))); break;
    case 'gradient': {
      const ang = b * Math.PI / 4, r = Math.hypot(w, h) / 2, cx = x + w / 2, cy = y + h / 2;
      const g = c.createLinearGradient(cx - Math.cos(ang) * r, cy - Math.sin(ang) * r, cx + Math.cos(ang) * r, cy + Math.sin(ang) * r);
      g.addColorStop(0, A); g.addColorStop(0.5, B); g.addColorStop(1, A);
      fill(g); break;
    }
    case 'rainbow': {
      const g = c.createLinearGradient(x, y, x + w, y + h);
      for (let i = 0; i <= 6; i++) g.addColorStop(i / 6, `hsl(${(b * 45 + i * 60) % 360},100%,50%)`);
      fill(g); break;
    }
    case 'chase': {
      fill(B);
      const R = Math.hypot(w, h) / 2 + 2, period = Math.max(w, h) / 4 || 1;
      c.save(); c.translate(x + w / 2, y + h / 2); c.rotate(Math.PI / 4); c.fillStyle = A;
      for (let k = -R - period + f * period; k < R; k += period) c.fillRect(k, -R, period / 2, 2 * R);
      c.restore(); break;
    }
    case 'wipe': fill(B); c.fillStyle = A; c.fillRect(x, y, w * f, h); break;
    case 'sparkle': {
      fill(B);
      const rand = rng(Math.floor(b * 4) * 7919 + s.id.charCodeAt(0));
      const n = Math.min(400, 15 + (w * h) / 2500), unit = W / 600;
      c.fillStyle = A;
      for (let i = 0; i < n; i++) {
        const px = x + rand() * w, py = y + rand() * h, r = (0.5 + rand() * 2) * unit;
        c.globalAlpha = rand() * s.opacity * state.master;
        c.beginPath(); c.arc(px, py, r, 0, 7); c.fill();
      }
      break;
    }
    case 'media': {
      const m = media[s.mediaId];
      const el = m && ensureMediaEl(m);
      if (el && mediaReady(el)) {
        const iw = el.videoWidth || el.naturalWidth, ih = el.videoHeight || el.naturalHeight;
        const sc = Math.max(w / iw, h / ih);                       // cover the shape
        c.drawImage(el, x + (w - iw * sc) / 2, y + (h - ih * sc) / 2, iw * sc, ih * sc);
      } else {                                                      // placeholder checkerboard
        const sz = W / 40;
        for (let i = 0; i * sz < w; i++) for (let j = 0; j * sz < h; j++) {
          c.fillStyle = (i + j) % 2 ? '#444' : '#222'; c.fillRect(x + i * sz, y + j * sz, sz, sz);
        }
      }
      break;
    }
    case 'grid': {
      fill('#000');
      c.strokeStyle = '#fff'; c.lineWidth = Math.max(1, W / 1000);
      c.beginPath();
      for (let i = 1; i < 8; i++) { c.moveTo(x + w * i / 8, y); c.lineTo(x + w * i / 8, y + h); c.moveTo(x, y + h * i / 8); c.lineTo(x + w, y + h * i / 8); }
      c.stroke();
      c.lineWidth = W / 300; tracePath(c, pts); c.stroke();
      c.fillStyle = A; c.font = `${Math.round(W / 60)}px sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle';
      pts.forEach(([px, py], i) => c.fillText(String(i + 1), px + (x + w / 2 - px) * 0.08, py + (y + h / 2 - py) * 0.08));
      break;
    }
  }
}

function drawShape(c, s, W, H, beat) {
  const pts = s.points.map(([px, py]) => [px * W, py * H]);
  if (pts.length < 3) return;
  let alpha = s.opacity * state.master;
  if (s.audio) alpha *= Math.min(1, 0.1 + audioLevel * 1.8);
  if (alpha <= 0.001) return;
  const b = beat * s.speed + s.phase;
  c.save();
  c.globalAlpha = alpha;
  if (s.effect === 'outline') {
    c.globalAlpha = alpha * (0.6 + 0.4 * Math.cos((((b % 1) + 1) % 1) * 2 * Math.PI));
    c.lineJoin = 'round'; c.strokeStyle = s.colorA; c.shadowColor = s.colorA;
    c.shadowBlur = W / 60 + s.feather * W / 1000; c.lineWidth = Math.max(2, W / 250);
    tracePath(c, pts); c.stroke(); c.stroke();
    c.restore(); return;
  }
  if (s.feather > 0) {
    const pad = s.feather * W / 500, bb = bbox(pts);
    bb.x -= pad; bb.y -= pad; bb.w += 2 * pad; bb.h += 2 * pad;
    fxCtx.setTransform(1, 0, 0, 1, 0, 0);
    fxCtx.globalCompositeOperation = 'source-over'; fxCtx.filter = 'none'; fxCtx.globalAlpha = 1;
    fxCtx.clearRect(0, 0, W, H);
    paint(fxCtx, s, bb, b, pts, W);
    fxCtx.globalAlpha = 1;
    fxCtx.globalCompositeOperation = 'destination-in';
    fxCtx.filter = `blur(${s.feather * W / 1000}px)`;
    tracePath(fxCtx, pts); fxCtx.fillStyle = '#fff'; fxCtx.fill();
    fxCtx.filter = 'none'; fxCtx.globalCompositeOperation = 'source-over';
    c.drawImage(fx, 0, 0);
  } else {
    tracePath(c, pts); c.clip();
    paint(c, s, bbox(pts), b, pts, W);
  }
  c.restore();
}

function drawTestGrid(c, W, H) {
  c.save();
  c.strokeStyle = '#fff'; c.lineWidth = Math.max(1, W / 1500);
  c.beginPath();
  for (let i = 0; i <= 16; i++) { c.moveTo(W * i / 16, 0); c.lineTo(W * i / 16, H); }
  for (let i = 0; i <= 9; i++) { c.moveTo(0, H * i / 9); c.lineTo(W, H * i / 9); }
  c.stroke();
  c.strokeStyle = '#ffd23f'; c.lineWidth = W / 400;
  c.strokeRect(c.lineWidth / 2, c.lineWidth / 2, W - c.lineWidth, H - c.lineWidth);
  c.beginPath(); c.moveTo(0, 0); c.lineTo(W, H); c.moveTo(W, 0); c.lineTo(0, H); c.stroke();
  c.beginPath(); c.arc(W / 2, H / 2, H * 0.42, 0, 7); c.stroke();
  c.restore();
}

function beatNow() { return ((Date.now() - state.beatOrigin) / 1000) * (state.bpm / 60); }

function frame() {
  resize();
  const W = canvas.width, H = canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  const beat = beatNow();
  if (!state.blackout) for (const s of state.shapes) if (s.visible) drawShape(ctx, s, W, H, beat);
  if (state.testGrid) drawTestGrid(ctx, W, H);
  if (!isOutput) editorFrame(W, H, beat);
  requestAnimationFrame(frame);
}

/* ---------------- output window ---------------- */
if (isOutput) {
  document.body.classList.add('output');
  document.title = 'Projector Mapper — Output';
  chan?.addEventListener('message', ({ data }) => {
    if (data.type === 'state') state = data.state;
    else if (data.type === 'audio') audioLevel = data.level;
    else if (data.type === 'media') {
      for (const m of data.list) if (!media[m.id]) media[m.id] = { ...m };
      for (const id of Object.keys(media)) if (!data.list.some((m) => m.id === id)) delete media[id];
    }
  });
  chan?.postMessage({ type: 'hello' });
  const toggleFs = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());
  addEventListener('dblclick', toggleFs);
  setTimeout(() => $('outputHint').classList.add('gone'), 5000);
  requestAnimationFrame(frame);
}

/* ================= editor ================= */
let editorFrame = () => {};
if (!isOutput) initEditor();

function initEditor() {
  let tool = 'select', selectedId = null, activeVertex = -1, drag = null, draft = null, hover = null;
  let perform = false, autoShow = false, lastAutoBlock = -1, tapTimes = [];
  let mic = null;
  const history = [];
  let histTimer = null, saveTimer = null;

  const sel = () => state.shapes.find((s) => s.id === selectedId) || null;
  const toPx = ([x, y]) => [x * canvas.width, y * canvas.height];
  const norm = (e) => [e.clientX / innerWidth, e.clientY / innerHeight];
  const dpr = () => window.devicePixelRatio || 1;

  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2200);
  }

  /* ----- persistence + sync ----- */
  function broadcast() { chan?.postMessage({ type: 'state', state }); }
  function broadcastMedia() {
    chan?.postMessage({ type: 'media', list: Object.values(media).map(({ id, name, type, url }) => ({ id, name, type, url })) });
  }
  function changed({ panel = true } = {}) {
    broadcast();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { try { localStorage.setItem('pm-state', JSON.stringify(state)); } catch {} }, 300);
    clearTimeout(histTimer);
    histTimer = setTimeout(pushHistory, 350);
    if (panel) refreshPanel();
  }
  function pushHistory() {
    histTimer = null;
    const j = JSON.stringify(state.shapes);
    if (j !== history[history.length - 1]) { history.push(j); if (history.length > 100) history.shift(); }
  }
  function undo() {
    if (histTimer) { clearTimeout(histTimer); pushHistory(); }
    if (history.length < 2) return toast('Nothing to undo');
    history.pop();
    state.shapes = JSON.parse(history[history.length - 1]);
    if (!sel()) selectedId = null;
    activeVertex = -1;
    broadcast(); refreshPanel();
    try { localStorage.setItem('pm-state', JSON.stringify(state)); } catch {}
  }

  // IndexedDB keeps uploaded images/videos across reloads.
  const idb = new Promise((res) => {
    try {
      const r = indexedDB.open('projector-mapper', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('media', { keyPath: 'id' });
      r.onsuccess = () => res(r.result); r.onerror = () => res(null);
    } catch { res(null); }
  });
  async function idbPut(rec) { const db = await idb; if (db) db.transaction('media', 'readwrite').objectStore('media').put(rec); }
  async function idbAll() {
    const db = await idb; if (!db) return [];
    return new Promise((res) => { const q = db.transaction('media').objectStore('media').getAll(); q.onsuccess = () => res(q.result); q.onerror = () => res([]); });
  }

  /* ----- shapes ----- */
  function newShape(points, kind) {
    const n = state.shapes.length;
    const hue = (n * 67) % 360;
    return {
      id: uid(), name: `${kind} ${n + 1}`, points, visible: true,
      effect: 'solid', colorA: hslHex(hue, 90, 55), colorB: '#000000', mediaId: null,
      speed: 1, phase: 0, opacity: 1, feather: 0, audio: false,
    };
  }
  function addShape(s) { state.shapes.push(s); selectedId = s.id; activeVertex = -1; setTool('select'); changed(); }
  function deleteSelected() {
    if (!sel()) return;
    state.shapes = state.shapes.filter((s) => s.id !== selectedId); selectedId = null; changed();
  }
  function duplicateSelected() {
    const s = sel(); if (!s) return;
    const c = JSON.parse(JSON.stringify(s));
    c.id = uid(); c.name = s.name + ' copy'; c.points = c.points.map(([x, y]) => [x + 0.02, y + 0.02]);
    addShape(c);
  }
  function moveOrder(d) {
    const i = state.shapes.findIndex((s) => s.id === selectedId), j = i + d;
    if (i < 0 || j < 0 || j >= state.shapes.length) return;
    [state.shapes[i], state.shapes[j]] = [state.shapes[j], state.shapes[i]]; changed();
  }
  function hitVertex(s, p, r = 12) {
    const P = toPx(p), R = r * dpr();
    for (let i = 0; i < s.points.length; i++) { const V = toPx(s.points[i]); if (Math.hypot(V[0] - P[0], V[1] - P[1]) < R) return i; }
    return -1;
  }
  function hitShape(p) {
    const P = toPx(p);
    for (let i = state.shapes.length - 1; i >= 0; i--) {
      const s = state.shapes[i];
      if (pointInPoly(P, s.points.map(toPx))) return s;
    }
    return null;
  }

  /* ----- tools & pointer ----- */
  function setTool(t) {
    tool = t; draft = null;
    document.querySelectorAll('#tools button').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
    canvas.style.cursor = t === 'select' ? 'default' : 'crosshair';
  }
  function finishPoly() {
    if (draft && draft.points.length >= 3) addShape(newShape(draft.points, 'Polygon'));
    draft = null;
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (perform || e.button === 2) return;
    const p = norm(e);
    if (tool === 'poly') {
      if (!draft) draft = { type: 'poly', points: [p] };
      else if (draft.points.length >= 3 && hitVertex({ points: [draft.points[0]] }, p) === 0) finishPoly();
      else draft.points.push(p);
      return;
    }
    if (tool === 'rect' || tool === 'circle') {
      draft = { type: tool, start: p, end: p }; canvas.setPointerCapture(e.pointerId); return;
    }
    const s = sel();
    if (s) {
      const vi = hitVertex(s, p);
      if (vi >= 0) { activeVertex = vi; drag = { kind: 'vertex', s, i: vi }; canvas.setPointerCapture(e.pointerId); return; }
    }
    const hit = hitShape(p);
    if (hit) {
      if (hit.id !== selectedId) activeVertex = -1;
      selectedId = hit.id; drag = { kind: 'move', s: hit, last: p }; canvas.setPointerCapture(e.pointerId);
    } else { selectedId = null; activeVertex = -1; }
    refreshPanel();
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = norm(e); hover = p;
    if (draft && draft.type !== 'poly') { draft.end = p; return; }
    if (!drag) return;
    if (drag.kind === 'vertex') { drag.s.points[drag.i] = [clamp(p[0], 0, 1), clamp(p[1], 0, 1)]; }
    else {
      const dx = p[0] - drag.last[0], dy = p[1] - drag.last[1];
      drag.s.points = drag.s.points.map(([x, y]) => [x + dx, y + dy]); drag.last = p;
    }
    changed({ panel: false });
  });
  canvas.addEventListener('pointerup', () => {
    if (draft && draft.type !== 'poly') {
      const [x0, y0] = draft.start, [x1, y1] = draft.end;
      const big = Math.abs(x1 - x0) * innerWidth > 8 || Math.abs(y1 - y0) * innerHeight > 8;
      if (big) {
        if (draft.type === 'rect') {
          addShape(newShape([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], 'Rect'));
        } else {
          // circle in screen pixels, stored as 32 editable points
          const r = Math.hypot((x1 - x0) * innerWidth, (y1 - y0) * innerHeight), pts = [];
          for (let i = 0; i < 32; i++) {
            const a = (i / 32) * Math.PI * 2;
            pts.push([x0 + (Math.cos(a) * r) / innerWidth, y0 + (Math.sin(a) * r) / innerHeight]);
          }
          addShape(newShape(pts, 'Circle'));
        }
      }
      draft = null;
    }
    if (drag) { drag = null; refreshPanel(); }
  });
  canvas.addEventListener('dblclick', (e) => {
    const s = sel(); if (tool !== 'select' || !s) return;
    const P = toPx(norm(e)), pts = s.points.map(toPx);
    let best = -1, bd = 10 * dpr();
    for (let i = 0; i < pts.length; i++) { const d = distToSeg(P, pts[i], pts[(i + 1) % pts.length]); if (d < bd) { bd = d; best = i; } }
    if (best >= 0) { s.points.splice(best + 1, 0, norm(e)); activeVertex = best + 1; changed(); }
  });
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (draft?.type === 'poly') { draft.points.pop(); if (!draft.points.length) draft = null; return; }
    const s = sel(); if (!s) return;
    const vi = hitVertex(s, norm(e));
    if (vi >= 0) {
      if (s.points.length <= 3) return toast('A shape needs at least 3 points');
      s.points.splice(vi, 1); activeVertex = -1; changed();
    }
  });

  /* ----- overlay drawing (editor only) ----- */
  editorFrame = (W, H, beat) => {
    $('beatDot').style.background = ((beat % 1) + 1) % 1 < 0.2 ? '#ffd23f' : '#333';
    if (autoShow) runAutoShow(beat);
    if (mic) updateMic();
    if (perform) return;
    const d = dpr(), hr = 6 * d;
    ctx.save();
    ctx.lineWidth = 1.5 * d; ctx.font = `${12 * d}px system-ui, sans-serif`; ctx.textAlign = 'center';
    for (const s of state.shapes) {
      const pts = s.points.map(toPx), isSel = s.id === selectedId;
      ctx.setLineDash(isSel ? [] : [6 * d, 4 * d]);
      ctx.strokeStyle = isSel ? '#ffd23f' : s.visible ? '#3fd0ff' : '#555';
      tracePath(ctx, pts); ctx.stroke();
      const bb = bbox(pts);
      ctx.fillStyle = '#ffffffcc'; ctx.fillText(s.name, bb.x + bb.w / 2, bb.y + bb.h / 2);
      if (isSel) {
        ctx.setLineDash([]);
        pts.forEach(([x, y], i) => {
          ctx.beginPath(); ctx.arc(x, y, i === activeVertex ? hr * 1.4 : hr, 0, 7);
          ctx.fillStyle = i === activeVertex ? '#ff7a1a' : '#ffd23f'; ctx.fill();
          ctx.strokeStyle = '#000'; ctx.stroke();
        });
      }
    }
    ctx.setLineDash([]);
    if (draft) {
      ctx.strokeStyle = '#7CFF6B'; ctx.fillStyle = '#7CFF6B33';
      let pts = [];
      if (draft.type === 'poly') pts = [...draft.points, ...(hover ? [hover] : [])].map(toPx);
      else if (draft.type === 'rect') { const [x0, y0] = toPx(draft.start), [x1, y1] = toPx(draft.end); pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]; }
      else { const c = toPx(draft.start), e = toPx(draft.end); ctx.beginPath(); ctx.arc(c[0], c[1], Math.hypot(e[0] - c[0], e[1] - c[1]), 0, 7); ctx.fill(); ctx.stroke(); }
      if (pts.length) {
        ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        if (draft.type === 'rect') ctx.closePath();
        ctx.fill(); ctx.stroke();
        if (draft.type === 'poly') draft.points.map(toPx).forEach(([x, y], i) => {
          ctx.beginPath(); ctx.arc(x, y, i === 0 ? hr * 1.5 : hr * 0.8, 0, 7); ctx.fillStyle = '#7CFF6B'; ctx.fill();
        });
      }
    }
    ctx.restore();
  };

  /* ----- panel ----- */
  const effectSelect = $('effectSelect');
  effectSelect.innerHTML = Object.entries(EFFECTS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  const esc = (t) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  function refreshPanel() {
    const list = $('shapeList');
    list.innerHTML = state.shapes.slice().reverse().map((s) => `
      <li data-id="${s.id}" class="${s.id === selectedId ? 'sel' : ''}">
        <span class="sw" style="background:${s.effect === 'rainbow' ? 'linear-gradient(90deg,red,yellow,lime,cyan,blue,magenta)' : s.colorA}"></span>
        <span class="nm">${esc(s.name)}</span><span class="fx">${EFFECTS[s.effect]}</span>
        <button class="eye" data-eye="${s.id}" title="Show / hide">${s.visible ? '●' : '○'}</button>
      </li>`).join('');
    $('emptyHint').hidden = state.shapes.length > 0;
    const s = sel();
    $('props').hidden = !s;
    if (!s) return;
    $('mediaSelect').innerHTML = '<option value="">— none —</option>' +
      Object.values(media).map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
    document.querySelectorAll('#props [data-prop]').forEach((el) => {
      const k = el.dataset.prop, v = s[k];
      if (el.type === 'checkbox') el.checked = !!v;
      else if (document.activeElement !== el) el.value = v ?? '';
    });
    document.querySelectorAll('#props output').forEach((o) => {
      const k = o.dataset.for, v = s[k];
      o.textContent = k === 'speed' ? `${v}×` : k === 'opacity' ? `${Math.round(v * 100)}%` : k === 'feather' ? v : (+v).toFixed(2);
    });
    $('mediaRow').style.display = s.effect === 'media' ? '' : 'none';
  }

  $('shapeList').addEventListener('click', (e) => {
    const eye = e.target.closest('[data-eye]');
    if (eye) { const s = state.shapes.find((x) => x.id === eye.dataset.eye); s.visible = !s.visible; changed(); return; }
    const li = e.target.closest('li'); if (!li) return;
    selectedId = li.dataset.id; activeVertex = -1; setTool('select'); refreshPanel();
  });
  document.querySelectorAll('#props [data-prop]').forEach((el) => {
    el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'color' ? 'change' : 'input', () => {
      const s = sel(); if (!s) return;
      const k = el.dataset.prop;
      s[k] = el.type === 'checkbox' ? el.checked : el.type === 'range' ? +el.value : el.value || (k === 'mediaId' ? null : el.value);
      if (k === 'effect' && s.effect === 'media' && !s.mediaId && Object.keys(media).length === 0) $('fileMedia').click();
      changed();
    });
    if (el.type === 'color') el.addEventListener('input', () => { const s = sel(); if (s) { s[el.dataset.prop] = el.value; changed({ panel: false }); } });
  });
  $('btnUpload').onclick = () => $('fileMedia').click();
  $('fileMedia').onchange = (e) => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    const m = { id: uid(), name: file.name, type: file.type.startsWith('video') ? 'video' : 'image', url: URL.createObjectURL(file) };
    media[m.id] = m;
    idbPut({ id: m.id, name: m.name, type: m.type, blob: file });
    const s = sel(); if (s) { s.effect = 'media'; s.mediaId = m.id; }
    broadcastMedia(); changed();
  };
  $('btnUp').onclick = () => moveOrder(1);
  $('btnDown').onclick = () => moveOrder(-1);
  $('btnDup').onclick = duplicateSelected;
  $('btnDel').onclick = deleteSelected;
  document.querySelectorAll('#tools button').forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));

  /* ----- top bar ----- */
  function setPerform(on) {
    perform = on; document.body.classList.toggle('perform', on);
    if (on) { document.documentElement.requestFullscreen?.().catch(() => {}); toast('Press H or Esc to return to the editor'); }
    else if (document.fullscreenElement) document.exitFullscreen();
  }
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && perform) setPerform(false); });
  $('btnPerform').onclick = () => setPerform(true);
  $('btnOutput').onclick = () => {
    const w = window.open(location.pathname + '?output', 'pm-output', 'width=1280,height=720');
    if (!w) toast('Allow pop-ups to open the output window');
  };
  $('bpm').onchange = (e) => {
    const beat = beatNow(); state.bpm = clamp(+e.target.value || 120, 20, 300);
    state.beatOrigin = Date.now() - (beat / (state.bpm / 60)) * 1000;   // keep the current beat phase
    e.target.value = state.bpm; changed({ panel: false });
  };
  function tap() {
    const now = Date.now();
    tapTimes = tapTimes.filter((t) => now - t < 2500); tapTimes.push(now);
    if (tapTimes.length >= 2) {
      const gaps = tapTimes.slice(1).map((t, i) => t - tapTimes[i]);
      state.bpm = Math.round(60000 / (gaps.reduce((a, b) => a + b) / gaps.length));
      state.bpm = clamp(state.bpm, 20, 300); $('bpm').value = state.bpm;
    }
    state.beatOrigin = now;                                              // land the beat on the tap
    changed({ panel: false });
  }
  $('btnTap').onclick = tap;
  $('master').oninput = (e) => { state.master = +e.target.value; changed({ panel: false }); };
  const toggleBtn = (id, key) => { state[key] = !state[key]; $(id).classList.toggle('on', state[key]); changed({ panel: false }); };
  $('btnBlackout').onclick = () => toggleBtn('btnBlackout', 'blackout');
  $('btnGrid').onclick = () => toggleBtn('btnGrid', 'testGrid');
  $('btnAuto').onclick = () => { autoShow = !autoShow; $('btnAuto').classList.toggle('on', autoShow); lastAutoBlock = -1;
    toast(autoShow ? 'Auto show: new looks every 8 beats' : 'Auto show off'); };
  $('btnUndo').onclick = undo;

  function runAutoShow(beat) {
    const block = Math.floor(beat / 8);
    if (block === lastAutoBlock) return;
    lastAutoBlock = block;
    const r = rng(block * 31 + 7), baseHue = Math.floor(r() * 360);
    const effect = AUTO_EFFECTS[Math.floor(r() * AUTO_EFFECTS.length)];
    const together = r() < 0.5;
    state.shapes.forEach((s, i) => {
      if (s.effect === 'media' || s.effect === 'grid') return;
      s.effect = together ? effect : AUTO_EFFECTS[Math.floor(r() * AUTO_EFFECTS.length)];
      s.colorA = hslHex((baseHue + i * (together ? 25 : 137)) % 360, 95, 55);
      s.colorB = r() < 0.6 ? '#000000' : hslHex((baseHue + 180) % 360, 90, 45);
      s.phase = together ? (i / Math.max(1, state.shapes.length)) % 1 : 0;
    });
    changed();
  }

  /* ----- microphone ----- */
  $('btnMic').onclick = async () => {
    if (mic) { mic.stream.getTracks().forEach((t) => t.stop()); mic.ac.close(); mic = null; audioLevel = 0;
      $('btnMic').classList.remove('on'); chan?.postMessage({ type: 'audio', level: 0 }); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ac = new AudioContext(), an = ac.createAnalyser(); an.fftSize = 1024;
      ac.createMediaStreamSource(stream).connect(an);
      mic = { stream, ac, an, buf: new Float32Array(an.fftSize), peak: 0.05 };
      $('btnMic').classList.add('on'); toast('Mic on — shapes with "React to sound" follow the music');
    } catch { toast('Microphone permission was denied'); }
  };
  function updateMic() {
    mic.an.getFloatTimeDomainData(mic.buf);
    let sum = 0; for (const v of mic.buf) sum += v * v;
    const rms = Math.sqrt(sum / mic.buf.length);
    mic.peak = Math.max(rms, mic.peak * 0.995, 0.02);                 // auto-gain
    const lvl = clamp(rms / mic.peak, 0, 1);
    audioLevel = lvl > audioLevel ? lvl : audioLevel * 0.85;
    chan?.postMessage({ type: 'audio', level: audioLevel });
  }

  /* ----- save / load ----- */
  $('btnSave').onclick = () => {
    const blob = new Blob([JSON.stringify({ app: 'projector-mapper', version: 1, ...state }, null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'projection-map.json' });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('btnLoad').onclick = () => $('fileLoad').click();
  $('fileLoad').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (!Array.isArray(d.shapes)) throw 0;
      loadState(d); selectedId = null; changed(); toast(`Loaded ${d.shapes.length} shapes`);
    } catch { toast('That file is not a Projector Mapper project'); }
  };
  function loadState(d) {
    state = { ...state, shapes: d.shapes, master: d.master ?? 1, bpm: d.bpm ?? 120, blackout: false, testGrid: false };
    $('bpm').value = state.bpm; $('master').value = state.master;
    $('btnBlackout').classList.remove('on'); $('btnGrid').classList.remove('on');
  }

  /* ----- keyboard ----- */
  addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if (mod && k === 'z') { e.preventDefault(); return undo(); }
    if (mod && k === 'd') { e.preventDefault(); return duplicateSelected(); }
    if (mod && k === 's') { e.preventDefault(); return $('btnSave').click(); }
    if (mod) return;
    if (k === 'h' || (k === 'escape' && perform)) return setPerform(!perform);
    if (k === 'b') return $('btnBlackout').click();
    if (k === 't') return tap();
    if (k === 'g') return $('btnGrid').click();
    if (perform) return;
    if (k === 'v') return setTool('select');
    if (k === 'p') return setTool('poly');
    if (k === 'r') return setTool('rect');
    if (k === 'c') return setTool('circle');
    if (k === 'enter') return finishPoly();
    if (k === 'escape') { draft = null; if (tool !== 'select') setTool('select'); else { selectedId = null; refreshPanel(); } return; }
    if (k === 'delete' || k === 'backspace') { e.preventDefault(); return deleteSelected(); }
    const arrows = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] }[k];
    const s = sel();
    if (arrows && s) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1, dx = (arrows[0] * step) / innerWidth, dy = (arrows[1] * step) / innerHeight;
      if (activeVertex >= 0 && s.points[activeVertex]) { const p = s.points[activeVertex]; s.points[activeVertex] = [p[0] + dx, p[1] + dy]; }
      else s.points = s.points.map(([x, y]) => [x + dx, y + dy]);
      changed({ panel: false });
    }
  });

  /* ----- output window handshake ----- */
  chan?.addEventListener('message', ({ data }) => { if (data.type === 'hello') { broadcastMedia(); broadcast(); } });

  /* ----- startup ----- */
  new ResizeObserver(([e]) => document.documentElement.style.setProperty('--top', e.target.offsetHeight + 'px')).observe($('topbar'));
  try { const saved = JSON.parse(localStorage.getItem('pm-state')); if (saved && Array.isArray(saved.shapes)) loadState(saved); } catch {}
  history.push(JSON.stringify(state.shapes));
  idbAll().then((recs) => {
    for (const r of recs) media[r.id] = { id: r.id, name: r.name, type: r.type, url: URL.createObjectURL(r.blob) };
    if (recs.length) { broadcastMedia(); refreshPanel(); }
  });
  refreshPanel();
  requestAnimationFrame(frame);
}

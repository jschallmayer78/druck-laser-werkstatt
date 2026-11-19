/* Schriftzug – bis zu vier Textebenen als 3D-Druck-Modell.
 *
 * Die Schriften werden im Browser gerendert (Google Fonts oder eigene Datei),
 * als Maske gerastert, mit Marching Squares in Konturen umgewandelt und zu
 * geschlossenen Netzen extrudiert. Der Server packt die Netze in die 3MF
 * (POST api/schriftzug); die SVG für den Laser entsteht direkt hier.
 */
(() => {
"use strict";
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const de = (v, d = 1) => v.toFixed(d).replace(".", ",");

const THREE_URL = "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js";
const ORBIT_URL = "https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js";

/* ------------------------------------------------------------ Schriften */
const FONTS = [
  { f: "Anton", w: 400, g: "Block" }, { f: "Bebas Neue", w: 400, g: "Block" }, { f: "Archivo Black", w: 400, g: "Block" },
  { f: "Alfa Slab One", w: 400, g: "Block" }, { f: "Bungee", w: 400, g: "Block" }, { f: "Lilita One", w: 400, g: "Block" },
  { f: "Titan One", w: 400, g: "Block" }, { f: "Luckiest Guy", w: 400, g: "Block" }, { f: "Black Ops One", w: 400, g: "Block" },
  { f: "Righteous", w: 400, g: "Block" }, { f: "Montserrat", w: 900, g: "Block" }, { f: "Roboto", w: 900, g: "Block" },
  { f: "Oswald", w: 700, g: "Block" }, { f: "Rubik Mono One", w: 400, g: "Block" },
  { f: "Pacifico", w: 400, g: "Schreibschrift" }, { f: "Lobster", w: 400, g: "Schreibschrift" },
  { f: "Dancing Script", w: 700, g: "Schreibschrift" }, { f: "Kaushan Script", w: 400, g: "Schreibschrift" },
  { f: "Great Vibes", w: 400, g: "Schreibschrift" }, { f: "Satisfy", w: 400, g: "Schreibschrift" },
  { f: "Yellowtail", w: 400, g: "Schreibschrift" }, { f: "Cookie", w: 400, g: "Schreibschrift" },
  { f: "Courgette", w: 400, g: "Schreibschrift" }, { f: "Damion", w: 400, g: "Schreibschrift" },
  { f: "Alex Brush", w: 400, g: "Schreibschrift" }, { f: "Allura", w: 400, g: "Schreibschrift" },
  { f: "Parisienne", w: 400, g: "Schreibschrift" }, { f: "Sacramento", w: 400, g: "Schreibschrift" },
  { f: "Playfair Display", w: 900, g: "Sonstige" }, { f: "Cinzel", w: 700, g: "Sonstige" },
  { f: "Fredoka One", w: 400, g: "Sonstige" }, { f: "Permanent Marker", w: 400, g: "Sonstige" },
  { f: "Special Elite", w: 400, g: "Sonstige" },
  { f: "Arial", w: 700, g: "System", sys: true }, { f: "Georgia", w: 700, g: "System", sys: true },
];
const fontKey = (o) => o.f + "|" + o.w;
const fontMap = new Map(FONTS.map(o => [fontKey(o), o]));
const linked = new Map();

function linkFont(o) {
  if (o.sys || o.custom) return Promise.resolve(true);
  const key = fontKey(o);
  if (linked.has(key)) return linked.get(key);
  const fam = encodeURIComponent(o.f).replace(/%20/g, "+") + (o.w !== 400 ? ":wght@" + o.w : "");
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = "https://fonts.googleapis.com/css2?family=" + fam + "&display=block";
  const pr = new Promise(res => { l.onload = () => res(true); l.onerror = () => res(false); setTimeout(() => res(false), 8000); });
  linked.set(key, pr);
  document.head.appendChild(l);
  return pr;
}
async function loadFont(o, sample) {
  if (o.sys) return;
  await linkFont(o);
  try { await Promise.race([document.fonts.load(`${o.w} 100px "${o.f}"`, sample || "Aa"), new Promise(r => setTimeout(r, 6000))]); } catch (e) {}
}
function fillFontSelect(sel, keep) {
  const prev = keep || sel.value;
  sel.innerHTML = "";
  const groups = {};
  for (const o of fontMap.values()) (groups[o.g] ||= []).push(o);
  for (const g of Object.keys(groups)) {
    const og = document.createElement("optgroup"); og.label = g;
    for (const o of groups[g]) {
      const op = new Option(o.f + (o.w >= 700 && !o.custom ? (o.w >= 900 ? " (Black)" : " (Bold)") : ""), fontKey(o));
      op.style.fontFamily = `"${o.f}"`;
      og.appendChild(op);
    }
    sel.appendChild(og);
  }
  if (prev && fontMap.has(prev)) sel.value = prev;
}

/* ------------------------------------------------------------ Text-Layout */
const scratch = document.createElement("canvas").getContext("2d");
const REF = 200;
const setLS = (ctx, px) => { if ("letterSpacing" in ctx) ctx.letterSpacing = px + "px"; };

/* ------------------------------------------------------------ SVG-Grafiken als Ebene */
const svgs = {};   // je Ebene: { name, src, vbW, vbH, ink: {x0,y0,x1,y1} als Anteil der Zeichenfläche }

function svgUrl(S, w, h) {
  const src = S.src.replace(/^<svg\b/, `<svg width="${w}" height="${h}"`);
  return URL.createObjectURL(new Blob([src], { type: "image/svg+xml" }));
}
function loadImage(url) {
  return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error("Die SVG-Datei lässt sich nicht darstellen.")); im.src = url; });
}
async function loadSvgFile(file, k) {
  const txt = await file.text();
  const doc = new DOMParser().parseFromString(txt, "image/svg+xml");
  const svg = doc.documentElement;
  if (!svg || svg.nodeName.toLowerCase() !== "svg" || doc.querySelector("parsererror")) throw new Error("Das ist keine gültige SVG-Datei.");
  let vb = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
  if (vb.length !== 4 || vb.some(x => !isFinite(x)) || vb[2] <= 0 || vb[3] <= 0) {
    const w = parseFloat(svg.getAttribute("width")) || 100, h = parseFloat(svg.getAttribute("height")) || 100;
    vb = [0, 0, w, h];
    svg.setAttribute("viewBox", vb.join(" "));
  }
  svg.removeAttribute("width"); svg.removeAttribute("height");
  svg.setAttribute("preserveAspectRatio", "none");
  if (!svg.getAttribute("xmlns")) svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const S = { name: file.name, src: new XMLSerializer().serializeToString(svg), vbW: vb[2], vbH: vb[3] };
  // sichtbare Fläche bestimmen (Ränder in der Zeichenfläche abschneiden)
  const ref = 1200, rw = Math.max(1, Math.round(S.vbW >= S.vbH ? ref : ref * S.vbW / S.vbH)), rh = Math.max(1, Math.round(S.vbH > S.vbW ? ref : ref * S.vbH / S.vbW));
  const url = svgUrl(S, rw, rh);
  try {
    const im = await loadImage(url);
    const c = document.createElement("canvas"); c.width = rw; c.height = rh;
    const cg = c.getContext("2d", { willReadFrequently: true });
    cg.drawImage(im, 0, 0, rw, rh);
    let d;
    try { d = cg.getImageData(0, 0, rw, rh).data; } catch (e) { throw new Error("Diese SVG kann der Browser nicht auslesen (z. B. wegen eingebetteter HTML-Inhalte)."); }
    let x0 = rw, y0 = rh, x1 = -1, y1 = -1;
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) if (d[(y * rw + x) * 4 + 3] > 20) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) throw new Error("Die SVG enthält keine sichtbare Fläche.");
    S.ink = { x0: x0 / rw, y0: y0 / rh, x1: (x1 + 1) / rw, y1: (y1 + 1) / rh };
  } finally { URL.revokeObjectURL(url); }
  svgs[k] = S;
  return S;
}

// Euklidische Abstandstransformation (Felzenszwalb) – wächst eine Maske um r Pixel
function dilate(a, W, H, r) {
  if (!(r > 0)) return a.slice();
  const INF = 1e20, N = W * H, f = new Float32Array(N);
  for (let i = 0; i < N; i++) f[i] = a[i] > 127 ? 0 : INF;
  const n = Math.max(W, H), buf = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  const pass = (len) => {
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < len; q++) {
      let p = v[k], s = ((buf[q] + q * q) - (buf[p] + p * p)) / (2 * q - 2 * p);
      while (s <= z[k]) { k--; p = v[k]; s = ((buf[q] + q * q) - (buf[p] + p * p)) / (2 * q - 2 * p); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) { while (z[k + 1] < q) k++; const p = v[k]; d[q] = (q - p) * (q - p) + buf[p]; }
  };
  for (let x = 0; x < W; x++) { for (let y = 0; y < H; y++) buf[y] = f[y * W + x]; pass(H); for (let y = 0; y < H; y++) f[y * W + x] = d[y]; }
  for (let y = 0; y < H; y++) { const r0 = y * W; for (let x = 0; x < W; x++) buf[x] = f[r0 + x]; pass(W); for (let x = 0; x < W; x++) f[r0 + x] = d[x]; }
  const o = new Uint8Array(N);
  for (let i = 0; i < N; i++) { const val = (r + 0.5 - Math.sqrt(f[i])) * 255; const c = val > 255 ? 255 : val < 0 ? 0 : val; o[i] = a[i] > c ? a[i] : c; }
  return o;
}

// Maße in mm, unabhängig von der Rasterauflösung
function measureLine(L) {
  if (L.kind === "svg") {
    const S = L.svg; if (!S) return null;
    const iw = (S.ink.x1 - S.ink.x0) * S.vbW, ih = (S.ink.y1 - S.ink.y0) * S.vbH;
    return { w: L.height * iw / ih, h: L.height };
  }
  if (!L.text.trim()) return null;
  const ctx = scratch;
  ctx.font = `${L.font.w} ${REF}px "${L.font.f}"`; setLS(ctx, 0);
  let m = ctx.measureText(L.text);
  const inkH = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
  if (!(inkH > 0)) return null;
  const mmPerRef = L.height / inkH;
  setLS(ctx, L.spacing / mmPerRef);
  m = ctx.measureText(L.text);
  setLS(ctx, 0);
  return {
    fontMm: REF * mmPerRef,
    w: (m.actualBoundingBoxLeft + m.actualBoundingBoxRight) * mmPerRef,
    h: (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) * mmPerRef,
  };
}
// Zeile so zeichnen, dass die Mitte ihrer Tinte auf (cx, cy) liegt (Canvas-Pixel)
function drawLine(ctx, L, M, q, cx, cy, strokeMm) {
  ctx.font = `${L.font.w} ${M.fontMm * q}px "${L.font.f}"`;
  setLS(ctx, L.spacing * q);
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  const m = ctx.measureText(L.text);
  const x = cx - (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2;
  const y = cy - (m.actualBoundingBoxDescent - m.actualBoundingBoxAscent) / 2;
  ctx.fillText(L.text, x, y);
  if (strokeMm > 0) {
    ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.lineWidth = 2 * strokeMm * q;
    ctx.strokeText(L.text, x, y);
  }
  setLS(ctx, 0);
}

/* ------------------------------------------------------------ Konturen (Marching Squares) */
function traceContours(alpha, w, h) {
  const T = 127.5, NH = w * h;
  const next = new Map(), px = new Map(), py = new Map();
  function edgePoint(e, i, j) {
    let k, x, y, a, b;
    switch (e) {
      case 0: k = j * w + i;          a = alpha[j * w + i];       b = alpha[j * w + i + 1];       x = i + (T - a) / (b - a); y = j; break;
      case 1: k = NH + j * w + i + 1; a = alpha[j * w + i + 1];   b = alpha[(j + 1) * w + i + 1]; x = i + 1; y = j + (T - a) / (b - a); break;
      case 2: k = (j + 1) * w + i;    a = alpha[(j + 1) * w + i]; b = alpha[(j + 1) * w + i + 1]; x = i + (T - a) / (b - a); y = j + 1; break;
      case 3: k = NH + j * w + i;     a = alpha[j * w + i];       b = alpha[(j + 1) * w + i];     x = i; y = j + (T - a) / (b - a); break;
    }
    if (!px.has(k)) { px.set(k, x); py.set(k, y); }
    return k;
  }
  // gemeinsame Ecke zweier benachbarter Kanten (0 oben, 1 rechts, 2 unten, 3 links), sonst oben links
  const cornerOf = (e1, e2) => { const s = e1 < e2 ? e1 * 4 + e2 : e2 * 4 + e1; return s === 1 ? 1 : s === 6 ? 2 : s === 11 ? 3 : 0; };
  const CX = [0, 1, 1, 0], CY = [0, 0, 1, 1];
  for (let j = 0; j < h - 1; j++) {
    const r0 = j * w, r1 = r0 + w;
    for (let i = 0; i < w - 1; i++) {
      const a = alpha[r0 + i], b = alpha[r0 + i + 1], c = alpha[r1 + i + 1], d = alpha[r1 + i];
      const tl = a > T, tr = b > T, br = c > T, bl = d > T;
      const code = (tl ? 1 : 0) | (tr ? 2 : 0) | (br ? 4 : 0) | (bl ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const ins = [tl, tr, br, bl], E = [];
      if (tl !== tr) E.push(0); if (tr !== br) E.push(1); if (bl !== br) E.push(2); if (tl !== bl) E.push(3);
      let pairs;
      if (E.length === 2) pairs = [[E[0], E[1]]];
      else pairs = (((a + b + c + d) / 4 > T) === tl) ? [[0, 1], [3, 2]] : [[0, 3], [1, 2]];
      for (const [e1, e2] of pairs) {
        let k1 = edgePoint(e1, i, j), k2 = edgePoint(e2, i, j);
        const ci = cornerOf(e1, e2), rx = i + CX[ci], ry = j + CY[ci];
        const x1 = px.get(k1), y1 = py.get(k1), x2 = px.get(k2), y2 = py.get(k2);
        const cr = (x2 - x1) * (ry - y1) - (y2 - y1) * (rx - x1);
        if (ins[ci] ? cr < 0 : cr > 0) { const t = k1; k1 = k2; k2 = t; }
        next.set(k1, k2);
      }
    }
  }
  const loops = [];
  for (const start of next.keys()) {
    if (!next.has(start)) continue;
    const pts = []; let k = start, guard = 0;
    for (;;) {
      pts.push(px.get(k) + 0.5, py.get(k) + 0.5);
      const n = next.get(k); next.delete(k);
      if (n === undefined || n === start || ++guard > 5e6) break;
      k = n;
    }
    if (pts.length >= 6) loops.push(pts);
  }
  return loops;
}
function simplifyClosed(p, tol) {
  const n = p.length / 2; if (n < 5) return p;
  let far = 0, fd = -1;
  for (let i = 1; i < n; i++) { const dx = p[2 * i] - p[0], dy = p[2 * i + 1] - p[1], d = dx * dx + dy * dy; if (d > fd) { fd = d; far = i; } }
  const keep = new Uint8Array(n); keep[0] = 1; keep[far] = 1;
  const tol2 = tol * tol, stack = [[0, far], [far, n]];
  while (stack.length) {
    const [s, e] = stack.pop();
    if (e - s < 2) continue;
    const ax = p[2 * s], ay = p[2 * s + 1], ei = e % n, bx = p[2 * ei], by = p[2 * ei + 1];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let md = -1, mi = -1;
    for (let i = s + 1; i < e; i++) {
      const x = p[2 * i], y = p[2 * i + 1];
      const d = L2 < 1e-12 ? (x - ax) ** 2 + (y - ay) ** 2 : ((x - ax) * dy - (y - ay) * dx) ** 2 / L2;
      if (d > md) { md = d; mi = i; }
    }
    if (md > tol2) { keep[mi] = 1; stack.push([s, mi], [mi, e]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(p[2 * i], p[2 * i + 1]);
  return out;
}
function signedArea(p) { let a = 0; const n = p.length / 2; for (let i = 0, j = n - 1; i < n; j = i++) a += p[2 * j] * p[2 * i + 1] - p[2 * i] * p[2 * j + 1]; return a / 2; }
function bbox(p) { let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; for (let i = 0; i < p.length; i += 2) { const x = p[i], y = p[i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return [x0, y0, x1, y1]; }
function pointInPoly(x, y, p) { let c = false; const n = p.length / 2; for (let i = 0, j = n - 1; i < n; j = i++) { const xi = p[2 * i], yi = p[2 * i + 1], xj = p[2 * j], yj = p[2 * j + 1]; if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) c = !c; } return c; }

/* Maske -> Flächen in mm (Außenkontur gegen den Uhrzeigersinn, Löcher im Uhrzeigersinn) */
function maskToShapes(alpha, w, h, q, ox, oy) {
  let loops = traceContours(alpha, w, h);
  const tol = Math.max(0.25, 0.02 * q);
  loops = loops.map(l => simplifyClosed(l, tol)).filter(l => l.length >= 6)
    .map(l => { const o = new Array(l.length); for (let i = 0; i < l.length; i += 2) { o[i] = (l[i] - ox) / q; o[i + 1] = (oy - l[i + 1]) / q; } return o; });
  const L = loops.map(p => ({ p, a: signedArea(p) })).filter(o => Math.abs(o.a) > 0.01);
  if (!L.length) return [];
  let maxI = 0; for (let i = 1; i < L.length; i++) if (Math.abs(L[i].a) > Math.abs(L[maxI].a)) maxI = i;
  if (L[maxI].a < 0) for (const o of L) { const p = o.p, r = []; for (let i = p.length - 2; i >= 0; i -= 2) r.push(p[i], p[i + 1]); o.p = r; o.a = -o.a; }
  for (const o of L) o.b = bbox(o.p);
  const outers = L.filter(o => o.a > 0).sort((x, y) => x.a - y.a), holes = L.filter(o => o.a < 0);
  for (const o of outers) o.holes = [];
  for (const hl of holes) {
    const x = hl.p[0], y = hl.p[1];
    for (const o of outers) {
      if (x < o.b[0] || x > o.b[2] || y < o.b[1] || y > o.b[3] || o.a < -hl.a) continue;
      if (pointInPoly(x, y, o.p)) { o.holes.push(hl.p); break; }
    }
  }
  return outers.map(o => ({ outer: o.p, holes: o.holes }));
}

/* Flächen -> geschlossenes, extrudiertes Dreiecksnetz */
function extrude(shapes, z0, z1) {
  const pos = [], idx = [];
  for (const s of shapes) {
    const toV = (p) => { const r = []; for (let i = 0; i < p.length; i += 2) r.push(new THREE.Vector2(p[i], p[i + 1])); return r; };
    const contour = toV(s.outer), hv = s.holes.map(toV);
    let tris;
    try { tris = THREE.ShapeUtils.triangulateShape(contour, hv); } catch (e) { continue; }
    const flat = [...contour, ...hv.flat()], n = flat.length, base = pos.length / 3;
    for (const v of flat) pos.push(v.x, v.y, z0);
    for (const v of flat) pos.push(v.x, v.y, z1);
    for (const t of tris) {
      let [A, B, C] = t;
      const cr = (flat[B].x - flat[A].x) * (flat[C].y - flat[A].y) - (flat[B].y - flat[A].y) * (flat[C].x - flat[A].x);
      if (cr === 0) continue;
      if (cr < 0) { const x = B; B = C; C = x; }
      idx.push(base + n + A, base + n + B, base + n + C);   // oben
      idx.push(base + A, base + C, base + B);               // unten
    }
    let off = 0;
    for (const ring of [contour, ...hv]) {                   // Seitenwände: Material liegt links
      const m = ring.length;
      for (let i = 0; i < m; i++) {
        const a = base + off + i, b = base + off + (i + 1) % m;
        idx.push(a, b, b + n, a, b + n, a + n);
      }
      off += m;
    }
  }
  return idx.length ? { pos: new Float32Array(pos), idx: new Uint32Array(idx) } : null;
}

function mergeMeshes(list) {
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  const np = list.reduce((s, m) => s + m.pos.length, 0), ni = list.reduce((s, m) => s + m.idx.length, 0);
  const pos = new Float32Array(np), idx = new Uint32Array(ni);
  let po = 0, io = 0;
  for (const m of list) {
    pos.set(m.pos, po);
    const base = po / 3;
    for (let i = 0; i < m.idx.length; i++) idx[io + i] = m.idx[i] + base;
    po += m.pos.length; io += m.idx.length;
  }
  return { pos, idx, layers: list.map(m => m.idx.length / 3) };   // Lagen verschmilzt der Server zu einem Körper
}

/* ------------------------------------------------------------ Ebenen */
const MAXL = 4;
const DEFAULTS = [
  { text: "ZUHAUSE", font: "Anton|400", height: 50, thick: 5, spacing: 0, grow: 0, color: "#F1EDE4", filament: "Weiß" },
  { text: "Willkommen", font: "Pacifico|400", height: 30, over: 2, x: 0, y: -6, spacing: 0, grow: 0.3, rim: 2.5,
    color: "#C4392D", filament: "Rot", mode: "embedded", embed: 2 },
  { text: "seit 2026", font: "Dancing Script|700", height: 9, over: 1, x: 42, y: -27, spacing: 0, grow: 0.3, rim: 1.5,
    color: "#2E4A7D", filament: "Blau", mode: "embedded", embed: 1 },
  { text: "Familie", font: "Great Vibes|400", height: 14, over: 1, x: -48, y: 27, spacing: 0, grow: 0.4, rim: 1.5,
    color: "#C9A227", filament: "Gold", mode: "embedded", embed: 1 },
];
const layerCount = () => { const r = document.querySelector("input[name=tCount]:checked"); return r ? +r.value : 2; };

function layerCard(k) {
  const d = DEFAULTS[k - 1], id = (f) => `t${k}${f}`, front = k > 1;
  const nf = (f, label, val, min, max, step) =>
    `<label class="f">${label}<input type="number" id="${id(f)}" value="${val}" min="${min}" max="${max}" step="${step}"></label>`;
  const opt = (v, t, s) =>
    `<label class="opt"><input type="radio" name="${id("Mode")}" value="${v}"${d.mode === v ? " checked" : ""}><span><b>${t}</b><small>${s}</small></span></label>`;
  return `<li class="step done tlayer" id="${id("Card")}">
  <h2>Ebene ${k}${k === 1 ? " – ganz hinten" : ""}</h2>
  <fieldset class="seg kind">
    <legend>Inhalt</legend>
    <label class="opt"><input type="radio" name="${id("Kind")}" value="text" checked><span><b>Text</b><small>Schrift aus der Liste</small></span></label>
    <label class="opt"><input type="radio" name="${id("Kind")}" value="svg"><span><b>Grafik (SVG)</b><small>Logo, Symbol, Wappen …</small></span></label>
  </fieldset>
  <div id="${id("SvgBox")}" hidden>
    <div class="tpick sub">
      <p class="hint" id="${id("SvgName")}">Noch keine SVG-Datei gewählt.</p>
      <button type="button" class="btn2" data-tsvg="${k}">SVG-Datei wählen …</button>
    </div>
    <p class="hint">Alles, was in der Grafik nicht durchsichtig ist, wird zur Fläche – Farben spielen keine Rolle.</p>
  </div>
  <div id="${id("TextBox")}">
  <label class="f">Text<input type="text" id="${id("Text")}" class="textin" value="${esc(d.text)}" maxlength="60"></label>
  <div class="tpick sub">
    <label class="f">Schriftart<select id="${id("Font")}" data-def="${d.font}"></select></label>
    <button type="button" class="btn2" data-tupload="${k}">Eigene Schrift …</button>
  </div>
  </div>
  <div class="fields">
    ${nf("Height", "Höhe (mm)", d.height, 3, 400, 1)}
    ${front ? nf("Over", `Überstand über Ebene ${k - 1} (mm)`, d.over, 0, 50, 0.2)
              + nf("X", "Versatz waagrecht (mm)", d.x, -500, 500, 1) + nf("Y", "Versatz senkrecht (mm)", d.y, -500, 500, 1)
            : nf("Thick", "Dicke (mm)", d.thick, 0.6, 50, 0.2)}
    <span id="${id("SpacingL")}" style="display:contents">${nf("Spacing", "Buchstabenabstand (mm)", d.spacing, -20, 50, 0.5)}</span>
    ${nf("Grow", "Verstärkung (mm)", d.grow, 0, 20, 0.1)}
    ${front ? nf("Rim", `Rand in Farbe von Ebene ${k - 1} (mm)`, d.rim, 0, 20, 0.5) : ""}
    <label class="f">Farbe<input type="color" id="${id("Color")}" value="${d.color}"></label>
    <label class="f">Filament<input type="text" id="${id("Name")}" value="${esc(d.filament)}" maxlength="30"></label>
  </div>
  ${front ? `
  <fieldset class="seg sub">
    <legend>Aufbau Ebene ${k}</legend>
    ${opt("stacked", "Aufgesetzt", "Liegt auf den Ebenen dahinter")}
    ${opt("embedded", "Eingelassen", "Sitzt in einer Vertiefung der Ebenen dahinter")}
    ${opt("through", "Durchgehend", "Reicht vor den Ebenen dahinter bis aufs Druckbett")}
  </fieldset>
  <div class="fields" id="${id("EmbedRow")}">${nf("Embed", "Einbettungstiefe (mm)", d.embed, 0.2, 50, 0.2)}</div>
  <label class="check"><input type="checkbox" id="${id("Insert")}"><span>Als Einlegeteil drucken: Aussparung in den Ebenen dahinter, das Teil liegt daneben in der 3MF</span></label>
  <div id="${id("ClearanceRow")}" hidden>
    <div class="fields">${nf("Clearance", "Spiel je Seite (mm)", 0.15, 0, 1, 0.05)}</div>
    <p class="hint">Die Aussparung ist um dieses Maß größer als das Einlegeteil; 0,1–0,2 mm passen für die meisten Drucker.</p>
  </div>
  <label class="check" id="${id("ToBedRow")}"><input type="checkbox" id="${id("ToBed")}" checked><span>Außerhalb der Ebenen dahinter bis aufs Druckbett führen</span></label>
  <div id="${id("DepthRow")}" hidden>
    <div class="fields">${nf("Depth", "Tiefe der Ebene (mm)", 4, 0.4, 50, 0.2)}</div>
    <p class="hint">Gemessen von ihrer Oberseite nach unten. Außerhalb der Ebenen dahinter hängt sie dann in der Luft und braucht im Slicer Stützen.</p>
  </div>` : `
  <p class="hint">Verstärkung macht die Buchstaben ringsum dicker; nahe Buchstaben verschmelzen dann zu einem Teil.</p>`}
</li>`;
}

function layerParams(k) {
  const g = (f) => $("#t" + k + f);
  const v = (f, d) => { const el = g(f); const x = el ? parseFloat(el.value) : NaN; return isFinite(x) ? x : d; };
  const L = {
    k, text: g("Text").value, font: fontMap.get(g("Font").value) || FONTS[0],
    kind: (document.querySelector(`input[name=t${k}Kind]:checked`) || { value: "text" }).value, svg: svgs[k] || null,
    height: Math.max(1, v("Height", 20)), spacing: v("Spacing", 0), grow: Math.max(0, v("Grow", 0)),
    color: g("Color").value.toUpperCase(), filament: g("Name").value.trim() || `Ebene ${k}`, x: 0, y: 0,
  };
  if (k === 1) L.thick = Math.max(0.4, v("Thick", 5));
  else Object.assign(L, {
    over: Math.max(0, v("Over", 1)), x: v("X", 0), y: v("Y", 0), rim: Math.max(0, v("Rim", 0)),
    mode: (document.querySelector(`input[name=t${k}Mode]:checked`) || { value: "embedded" }).value,
    embed: Math.max(0, v("Embed", 1)), insert: g("Insert").checked, clearance: Math.max(0, v("Clearance", 0.15)),
    toBed: g("ToBed").checked, depth: Math.max(0.4, v("Depth", 4)),
  });
  return L;
}
function params() {
  const n = layerCount(), layers = [];
  for (let k = 1; k <= n; k++) layers.push(layerParams(k));
  const v = (id, d) => { const x = parseFloat($("#" + id).value); return isFinite(x) ? x : d; };
  const base = {
    on: $("#tBaseOn").checked,
    shape: (document.querySelector("input[name=tBaseShape]:checked") || { value: "rect" }).value,
    margin: Math.max(0, v("tBaseMargin", 6)), thick: Math.max(0.4, v("tBaseThick", 3)), radius: Math.max(0, v("tBaseRadius", 6)),
    color: $("#tBaseColor").value.toUpperCase(), filament: $("#tBaseName").value.trim() || "Basisplatte",
    same: $("#tBaseSame").checked,
    stand: {
      on: $("#tStandOn").checked, kind: $("#tStandKind").value,
      angle: Math.min(30, Math.max(0, v("tStandAngle", 10))), depth: Math.max(3, v("tStandDepth", 8)),
      clearance: Math.max(0, v("tStandClear", 0.2)), foot: Math.max(15, v("tStandFoot", 35)),
    },
  };
  return { layers, base, q: parseFloat($("#tQuality").value) || 10 };
}

/* ------------------------------------------------------------ Masken (Alpha 0–255, weiche Kanten bleiben erhalten) */
const mUnion = (a, b) => { const o = new Uint8Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] > b[i] ? a[i] : b[i]; return o; };
const mUnionInto = (o, b) => { for (let i = 0; i < o.length; i++) if (b[i] > o[i]) o[i] = b[i]; return o; };
const mCut = (a, b) => { const o = new Uint8Array(a.length); for (let i = 0; i < a.length; i++) { const nb = 255 - b[i]; o[i] = a[i] < nb ? a[i] : nb; } return o; };
const mAnd = (a, b) => { const o = new Uint8Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] < b[i] ? a[i] : b[i]; return o; };
const mAny = (a) => { for (let i = 0; i < a.length; i++) if (a[i] > 127) return true; return false; };
const mSame = (a, b) => { if (!a || !b) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };

/* ------------------------------------------------------------ Generierung
 * Jede Ebene i belegt über ihrer Grundfläche eine Säule von einer Unterkante
 * bis zu ihrer Oberkante T_i. Die Unterkante hängt davon ab, welche Ebene an der
 * Stelle die oberste dahinter ist (aufgesetzt / eingelassen / durchgehend) oder
 * ob dort gar keine ist (Druckbett oder eigene Tiefe). Das Modell wird in
 * Höhenbänder zerlegt; in jedem Band gehört ein Pixel der vordersten Ebene, die
 * es abdeckt. Einlegeteile schneiden ihre Aussparung (mit Spiel) aus und werden
 * als flaches Teil daneben gelegt.
 */
async function generate(P) {
  const all = P.layers;
  const has = (L) => L.kind === "svg" ? !!L.svg : !!L.text.trim();
  if (!has(all[0])) throw new Error(all[0].kind === "svg" ? "Für Ebene 1 bitte eine SVG-Datei wählen." : "Ebene 1 braucht einen Text.");
  const Ls = all.filter(has);
  await Promise.all(Ls.filter(L => L.kind !== "svg").map(L => loadFont(L.font, L.text)));
  for (const L of Ls) L.M = measureLine(L);
  const layers = Ls.filter(L => L.M);
  if (!layers.length || layers[0].k !== 1) throw new Error("Ebene 1 ergibt keine druckbare Fläche.");

  // Oberkanten
  layers.forEach((L, i) => {
    L.T = i === 0 ? L.thick : layers[i - 1].T + (L.mode === "stacked" ? Math.max(0.2, L.over) : L.over);
  });

  // Raster
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, hmax = 0;
  for (const L of layers) {
    const m = L.grow + (L.rim || 0) + (L.insert ? L.clearance : 0);
    x0 = Math.min(x0, L.x - L.M.w / 2 - m); x1 = Math.max(x1, L.x + L.M.w / 2 + m);
    y0 = Math.min(y0, L.y - L.M.h / 2 - m); y1 = Math.max(y1, L.y + L.M.h / 2 + m);
    hmax = Math.max(hmax, L.M.h);
  }
  // Basisplatte (in mm, um den Inhalt herum)
  const BP = P.base, BT = BP.on ? BP.thick : 0;
  let bgeo = null;
  if (BP.on) {
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, hw = (x1 - x0) / 2, hh = (y1 - y0) / 2;
    if (BP.shape === "oval") bgeo = { cx, cy, a: hw * Math.SQRT2 + BP.margin, b: hh * Math.SQRT2 + BP.margin };
    else if (BP.shape === "rect") bgeo = { cx, cy, a: hw + BP.margin, b: hh + BP.margin, r: Math.min(BP.radius, hw + BP.margin, hh + BP.margin) };
    else bgeo = { cx, cy, a: hw + BP.margin, b: hh + BP.margin };
    x0 = Math.min(x0, cx - bgeo.a); x1 = Math.max(x1, cx + bgeo.a); y0 = Math.min(y0, cy - bgeo.b); y1 = Math.max(y1, cy + bgeo.b);
    if (BP.stand.on) y0 -= BP.stand.depth + 2;   // Platz für die Steckzunge
  }
  const pad = 1.5 + hmax * 0.08;
  x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  let q = P.q;
  const maxPix = 10e6;
  if ((x1 - x0) * (y1 - y0) * q * q > maxPix) q = Math.sqrt(maxPix / ((x1 - x0) * (y1 - y0)));
  const W = Math.ceil((x1 - x0) * q), H = Math.ceil((y1 - y0) * q);
  const ox = -x0 * q, oy = y1 * q;
  const canvas = document.createElement("canvas"); canvas.width = W; canvas.height = H;
  const g = canvas.getContext("2d", { willReadFrequently: true });
  const readAlpha = () => {
    const d = g.getImageData(0, 0, W, H).data, a = new Uint8Array(W * H);
    for (let i = 0, j = 3; i < a.length; i++, j += 4) a[i] = d[j];
    for (let i = 0; i < W; i++) { a[i] = 0; a[(H - 1) * W + i] = 0; }
    for (let j = 0; j < H; j++) { a[j * W] = 0; a[j * W + W - 1] = 0; }
    return a;
  };
  const svgBase = new Map();   // Raster der Grafik ohne Verstärkung, je Ebene einmal
  const raster = async (L, strokeMm) => {
    if (L.kind === "svg") {
      if (!svgBase.has(L)) {
        const S = L.svg, ink = S.ink;
        const fh = L.height * q / (ink.y1 - ink.y0), fw = fh * S.vbW / S.vbH;
        const url = svgUrl(S, Math.max(1, Math.round(fw)), Math.max(1, Math.round(fh)));
        try {
          const im = await loadImage(url);
          const cx = ox + L.x * q, cy = oy - L.y * q;
          g.clearRect(0, 0, W, H);
          g.drawImage(im, cx - (ink.x0 + ink.x1) / 2 * fw, cy - (ink.y0 + ink.y1) / 2 * fh, fw, fh);
          let a;
          try { a = readAlpha(); } catch (e) { throw new Error("Diese SVG kann der Browser nicht auslesen."); }
          for (let i = 0; i < a.length; i++) if (a[i] <= 20) a[i] = 0;   // Hauch von Transparenz ignorieren
          svgBase.set(L, a);
        } finally { URL.revokeObjectURL(url); }
      }
      return dilate(svgBase.get(L), W, H, strokeMm * q);
    }
    g.clearRect(0, 0, W, H); g.fillStyle = "#000"; g.strokeStyle = "#000";
    drawLine(g, L, L.M, q, ox + L.x * q, oy - L.y * q, strokeMm);
    return readAlpha();
  };
  let baseMask = null;
  if (BP.on) {
    if (BP.shape === "contour") {
      for (const L of layers) {
        const m = await raster(L, L.grow + (L.rim || 0) + (L.insert ? L.clearance : 0) + BP.margin);
        baseMask = baseMask ? mUnionInto(baseMask, m) : m;
      }
    } else if (BP.shape === "rect") {
      g.clearRect(0, 0, W, H); g.fillStyle = "#000"; g.beginPath();
      const px = ox + bgeo.cx * q, py = oy - bgeo.cy * q, A = bgeo.a * q, B = bgeo.b * q;
      {
        const r = (bgeo.r || 0) * q, l = px - A, t = py - B, rr = px + A, bb = py + B;
        g.moveTo(l + r, t); g.lineTo(rr - r, t); g.arcTo(rr, t, rr, t + r, r); g.lineTo(rr, bb - r); g.arcTo(rr, bb, rr - r, bb, r);
        g.lineTo(l + r, bb); g.arcTo(l, bb, l, bb - r, r); g.lineTo(l, t + r); g.arcTo(l, t, l + r, t, r); g.closePath();
      }
      g.fill();
      baseMask = readAlpha();
    }
  }
  for (const L of layers) {
    L.F = await raster(L, L.grow);
    if (L.rim > 0) L.D = await raster(L, L.grow + L.rim);
    if (L.insert) L.Pk = await raster(L, L.grow + L.clearance);
  }
  if (BP.on && BP.shape === "oval") {
    // kleinste Ellipse (Seitenverhältnis des Inhalts), die alle Schriftpixel umschließt, plus Rand
    const hw = bgeo.a - BP.margin, hh = bgeo.b - BP.margin;   // vorläufig: Rahmen × √2
    const rx = hw / Math.SQRT2 * q, ry = hh / Math.SQRT2 * q, pcx = ox + bgeo.cx * q, pcy = oy - bgeo.cy * q;
    let smax = 0;
    for (const L of layers) for (const m of [L.F, L.D, L.Pk]) {
      if (!m) continue;
      for (let j = 0; j < H; j++) {
        const dy = (j + 0.5 - pcy) / ry, row = j * W;
        for (let i = 0; i < W; i++) if (m[row + i] > 127) { const dx = (i + 0.5 - pcx) / rx, v2 = dx * dx + dy * dy; if (v2 > smax) smax = v2; }
      }
    }
    const sc = Math.sqrt(smax) || 1;
    g.clearRect(0, 0, W, H); g.fillStyle = "#000"; g.beginPath();
    g.ellipse(pcx, pcy, rx * sc + BP.margin * q, ry * sc + BP.margin * q, 0, 0, Math.PI * 2);
    g.fill();
    baseMask = readAlpha();
  }
  // Steckzunge unter der Platte für den Ständer: gerade Unterkante, so tief wie der Schlitz
  let tongue = null;
  if (BP.on && BP.stand.on && baseMask) {
    let jBot = -1, i0 = W, i1 = -1;
    for (let j = 0; j < H; j++) { const row = j * W; for (let i = 0; i < W; i++) if (baseMask[row + i] > 127) { if (j > jBot) jBot = j; if (i < i0) i0 = i; if (i > i1) i1 = i; } }
    if (jBot >= 0) {
      const tw = (i1 - i0) / q * (BP.stand.kind === "two" ? 0.8 : 0.6);
      const ci = (i0 + i1) / 2, a0 = Math.max(0, Math.round(ci - tw * q / 2)), a1 = Math.min(W - 1, Math.round(ci + tw * q / 2));
      let jTop = jBot;                       // höchste Unterkante der Platte innerhalb der Zungenbreite
      for (let i = a0; i <= a1; i++) { let jb = -1; for (let j = H - 1; j >= 0; j--) if (baseMask[j * W + i] > 127) { jb = j; break; } if (jb >= 0 && jb < jTop) jTop = jb; }
      const yTopPx = jTop - 1 * q, yBotPx = jBot + BP.stand.depth * q;
      g.clearRect(0, 0, W, H); g.fillStyle = "#000"; g.fillRect(a0, yTopPx, a1 - a0, yBotPx - yTopPx);
      mUnionInto(baseMask, readAlpha());
      tongue = { w: (a1 - a0) / q, xmid: ((a0 + a1) / 2 - ox) / q };
    }
  }

  // Materialfläche je Ebene: eigene Schrift + Ränder der Ebenen davor
  const solid = layers.filter(L => !L.insert);
  for (const L of solid) L.E = L.F.slice();
  layers.forEach((L, i) => {
    if (i === 0 || !L.D) return;
    let owner = null;
    for (let j = i - 1; j >= 0; j--) if (!layers[j].insert) { owner = layers[j]; break; }
    if (!owner) return;
    mUnionInto(owner.E, L.insert ? L.D : mCut(L.D, L.F));   // Einlegeteil: voller Boden unter Rand und Aussparung
  });

  // Regionen mit fester Unterkante
  const botOver = (L, Tj) => L.mode === "stacked" ? Tj : L.mode === "through" ? 0 : Math.max(0, Tj - L.embed);
  layers.forEach((L, i) => {
    const foot = L.insert ? L.Pk : L.E;
    L.regions = [];
    if (i === 0) { L.regions.push({ mask: foot, bot: 0 }); return; }
    const behind = solid.filter(S => layers.indexOf(S) < i);
    let above = null;                         // Vereinigung der Ebenen zwischen j und i
    for (let b = behind.length - 1; b >= 0; b--) {
      const S = behind[b];
      let r = mAnd(foot, S.E);
      if (above) r = mCut(r, above);
      if (mAny(r)) L.regions.push({ mask: r, bot: botOver(L, S.T), over: true });
      above = above ? mUnion(above, S.E) : S.E.slice();
    }
    if (!L.insert) {
      const free = above ? mCut(foot, above) : foot;
      if (mAny(free)) { L.regions.push({ mask: free, bot: L.toBed ? 0 : Math.max(0, Math.min(L.T - 0.2, L.T - L.depth)), free: true }); L.freeBot = L.regions.at(-1).bot; }
    }
    if (L.insert && L.mode === "stacked") L.regions = [];   // aufgeklebt: keine Aussparung
  });

  // Höhenbänder
  const topZ = Math.max(...solid.map(L => L.T));
  const zs = new Set([0, topZ]);
  for (const L of solid) zs.add(L.T);
  for (const L of layers) for (const r of L.regions) if (r.bot < topZ) zs.add(r.bot);
  const levels = [...zs].map(z => Math.round(z * 1000) / 1000).filter((z, i, a) => a.indexOf(z) === i && z <= topZ).sort((a, b) => a - b);

  const runs = new Map(solid.map(L => [L, { mask: null, z0: 0, pieces: [] }]));
  const flush = (L, z1) => {
    const run = runs.get(L);
    if (run.mask && mAny(run.mask) && z1 > run.z0 + 1e-6) {
      const shapes = maskToShapes(run.mask, W, H, q, ox, oy);
      const m = extrude(shapes, run.z0, z1);
      if (m) run.pieces.push(m);
    }
  };
  const eps = 1e-6;
  for (let b = 0; b + 1 < levels.length; b++) {
    const za = levels[b], zb = levels[b + 1];
    let acc = null;
    for (let i = layers.length - 1; i >= 0; i--) {
      const L = layers[i];
      let cover = null;
      if (L.insert || L.T >= zb - eps) {
        for (const r of L.regions) if (r.bot <= za + eps) cover = cover ? mUnionInto(cover, r.mask) : r.mask.slice();
      }
      if (!L.insert) {
        const own = cover ? (acc ? mCut(cover, acc) : cover) : null;
        const run = runs.get(L);
        if (!mSame(own, run.mask) && !(own === null && run.mask === null)) {
          flush(L, za);
          run.mask = own; run.z0 = za;
        }
      }
      if (cover) acc = acc ? mUnionInto(acc, cover) : cover.slice();
    }
  }
  for (const L of solid) flush(L, levels.at(-1));

  // Basisplatte: alles um ihre Dicke anheben, Platte darunter
  let baseMesh = null;
  if (BP.on) {
    for (const L of solid) for (const m of runs.get(L).pieces) for (let i = 2; i < m.pos.length; i += 3) m.pos[i] += BT;
    let shapes = maskToShapes(baseMask, W, H, q, ox, oy);
    // Kontur: Löcher (z. B. im „O“) schließen, Inseln darin weglassen
    if (BP.shape === "contour") shapes = shapes.filter(s => !shapes.some(o => o !== s && pointInPoly(s.outer[0], s.outer[1], o.outer))).map(s => ({ outer: s.outer, holes: [] }));
    baseMesh = extrude(shapes, 0, BT);
  }
  const parts = [];
  for (const L of solid) {
    let pieces = runs.get(L).pieces;
    if (baseMesh && BP.same && L === layers[0]) pieces = [baseMesh, ...pieces];
    const mesh = mergeMeshes(pieces);
    if (mesh) parts.push({ name: `Ebene ${L.k}`, k: L.k, filament: L.filament, color: L.color, mesh, layer: L });
  }
  if (baseMesh && !BP.same) parts.push({ name: "Basisplatte", k: 99, filament: BP.filament, color: BP.color, mesh: baseMesh, base: true });
  if (!parts.length) throw new Error("Aus dem Text ist keine druckbare Fläche entstanden.");

  // Einlegeteile: in der Vorschau eingesetzt, in der 3MF flach unter dem Schild
  let yNext = 1e9;
  for (const p of parts) for (let i = 1; i < p.mesh.pos.length; i += 3) yNext = Math.min(yNext, p.mesh.pos[i]);
  for (const [i, L] of layers.entries()) {
    if (!L.insert) continue;
    let prev = null;
    for (let j = i - 1; j >= 0; j--) if (!layers[j].insert) { prev = layers[j]; break; }
    const base = L.mode === "stacked" ? prev.T : botOver(L, prev.T);
    const shapes = maskToShapes(L.F, W, H, q, ox, oy);
    const mesh = extrude(shapes, base + BT, L.T + BT);
    if (!mesh) continue;
    let yMax = -1e9; for (const s of shapes) yMax = Math.max(yMax, bbox(s.outer)[3]);
    let yMin = 1e9; for (const s of shapes) yMin = Math.min(yMin, bbox(s.outer)[1]);
    const dy = yNext - 10 - yMax;
    yNext = yMin + dy;
    L.base = base;
    parts.push({ name: `Ebene ${L.k} (Einlegeteil)`, k: L.k, filament: L.filament, color: L.color, mesh, layer: L, insert: true, exportOffset: [0, dy, -(base + BT)] });
  }
  // Ständer: Profil mit schrägem Schlitz, entlang x extrudiert, flach auf dem Druckbett
  if (tongue) {
    const S = BP.stand, a = S.angle * Math.PI / 180, wv = BT + 2 * S.clearance, h = S.depth, zf = 3, Hs = h + zf, D = S.foot;
    const wh = wv / Math.cos(a), sh = h * Math.tan(a);
    const yb = Math.max(4, D * 0.35 - wh / 2);
    const prof = [0, 0, D, 0, D, Hs, yb + wh + sh, Hs, yb + wh, zf, yb, zf, yb + sh, Hs, 0, Hs];
    const lens = S.kind === "two" ? [30, 30] : [tongue.w];
    const total = lens.reduce((x, y) => x + y, 0) + (lens.length - 1) * 10;
    const pieces = [];
    let xs = tongue.xmid - total / 2;
    const yoff = yNext - 10 - D;
    for (const len of lens) {
      const m = extrude([{ outer: prof, holes: [] }], 0, len);
      const pos = new Float32Array(m.pos.length);
      for (let i = 0; i < pos.length; i += 3) { pos[i] = m.pos[i + 2] + xs; pos[i + 1] = m.pos[i] + yoff; pos[i + 2] = m.pos[i + 1]; }
      pieces.push({ pos, idx: m.idx });
      xs += len + 10;
    }
    const merged = mergeMeshes(pieces); delete merged.layers;   // getrennte Körper, nicht vereinigen
    const col = BP.same ? layers[0] : { color: BP.color, filament: BP.filament };
    parts.push({ name: "Ständer", k: 100, filament: col.filament, color: col.color, mesh: merged, stand: true,
                 standInfo: { angle: S.angle, depth: h, slot: wv, kind: S.kind } });
  }
  parts.sort((a, b) => a.k - b.k);

  // für die SVG: sichtbare Fläche je Ebene
  const svgMasks = layers.map(L => ({ name: `Ebene_${L.k}`, color: L.color, mask: L.insert ? L.F : L.E }));
  if (baseMask) svgMasks.unshift({ name: "Basisplatte", color: BP.same ? layers[0].color : BP.color, mask: baseMask, solid: BP.shape === "contour" });
  return { parts, layers, q, reduced: q < P.q - 0.01, baseT: BT, base: BP, svg: { svgMasks, W, H, q, ox, oy } };
}

/* ------------------------------------------------------------ 3D-Vorschau */
let renderer, scene, camera, controls, group, fitKey = "", resizeView = () => {};
function initView() {
  const el = $("#tView");
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  el.appendChild(renderer.domElement);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(35, 1, 1, 20000);
  camera.up.set(0, 0, 1);
  controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445066, 0.8));
  const d1 = new THREE.DirectionalLight(0xffffff, 0.75); d1.position.set(-1, -2, 3); scene.add(d1);
  const d2 = new THREE.DirectionalLight(0xffe2b0, 0.3); d2.position.set(2, 1, 1.5); scene.add(d2);
  group = new THREE.Group(); scene.add(group);
  resizeView = () => { const w = el.clientWidth, h = el.clientHeight; if (!w || !h) return; renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); };
  new ResizeObserver(resizeView).observe(el); resizeView();
  (function loop() { requestAnimationFrame(loop); controls.update(); renderer.render(scene, camera); })();
}
function showParts(parts) {
  while (group.children.length) { const c = group.children.pop(); c.geometry.dispose(); c.material.dispose(); }
  const box = new THREE.Box3();
  for (const p of parts) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(p.mesh.pos, 3));
    g.setIndex(new THREE.BufferAttribute(p.mesh.idx, 1));
    const ng = g.toNonIndexed(); ng.computeVertexNormals(); g.dispose();
    group.add(new THREE.Mesh(ng, new THREE.MeshStandardMaterial({ color: p.color, roughness: 0.6, metalness: 0.02 })));
    ng.computeBoundingBox(); box.union(ng.boundingBox);
  }
  const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  const key = Math.round(size.x / 10) + "x" + Math.round(size.y / 10);
  if (key !== fitKey) {
    fitKey = key;
    const D = Math.max(size.x, size.y * 1.6) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / Math.max(0.6, Math.min(1.6, camera.aspect));
    controls.target.copy(c);
    camera.position.set(c.x, c.y - D * 0.55, c.z + D * 0.95);
    camera.near = Math.max(0.5, D / 200); camera.far = D * 50; camera.updateProjectionMatrix();
  }
  return size;
}
function thumbnail() {
  try {
    renderer.render(scene, camera);
    const src = renderer.domElement, s = 256, c = document.createElement("canvas");
    c.width = s; c.height = s;
    const g = c.getContext("2d"), k = Math.min(s / src.width, s / src.height);
    g.drawImage(src, (s - src.width * k) / 2, (s - src.height * k) / 2, src.width * k, src.height * k);
    return c.toDataURL("image/png");
  } catch (e) { return null; }
}


/* ------------------------------------------------------------ Ausgabe */
function b64(typed) {
  const u8 = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
  let s = "";
  for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768));
  return btoa(s);
}
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
const baseName = () => ($("#tName").value.trim() || "schriftzug").replace(/[\\/:*?"<>|]+/g, "_");

// Exportlage: Einlegeteile liegen flach neben dem Schild auf dem Druckbett
function shifted(p) {
  if (!p.exportOffset) return p.mesh.pos;
  const [dx, dy, dz] = p.exportOffset, out = new Float32Array(p.mesh.pos.length);
  for (let i = 0; i < out.length; i += 3) { out[i] = p.mesh.pos[i] + dx; out[i + 1] = p.mesh.pos[i + 1] + dy; out[i + 2] = p.mesh.pos[i + 2] + dz; }
  return out;
}
function minZ(pos) { let z = Infinity; for (let i = 2; i < pos.length; i += 3) if (pos[i] < z) z = pos[i]; return z; }
// Beginnt ein Teil über dem Druckbett, muss alles ein Objekt sein: Slicer setzen
// jedes Objekt beim Laden auf die Druckplatte und würden es absenken.
function floating() { return !!current && current.parts.some(p => minZ(shifted(p)) > 1e-3); }

async function download3mf() {
  if (!current) return;
  const err = $("#tError"); err.hidden = true;
  const go = $("#tGo"); go.disabled = true; go.textContent = "3MF wird gepackt …";
  try {
    const anyInsert = current.parts.some(p => p.insert);
    const body = {
      title: baseName(), separate: (anyInsert || !$("#tAssembly").checked) && !floating(), thumbnail: thumbnail(),
      parts: current.parts.map(p => ({ name: p.name, filament: p.filament, color: p.color, verts: b64(shifted(p)), faces: b64(p.mesh.idx), layers: p.mesh.layers || null, own_object: !!(p.insert || p.stand) })),
    };
    const r = await fetch("api/schriftzug", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(typeof j.detail === "string" ? j.detail : "Die 3MF konnte nicht erzeugt werden."); }
    saveBlob(await r.blob(), baseName() + ".3mf");
    $("#t4").classList.add("done");
  } catch (ex) {
    err.textContent = ex.message === "Failed to fetch" ? "Der Server ist nicht erreichbar." : ex.message; err.hidden = false;
  } finally { go.disabled = false; go.textContent = "3MF herunterladen"; }
}

// SVG mit allen Ebenen in ihren Farben, von hinten nach vorne (LightBurn legt je Farbe eine Ebene an)
function downloadSvg() {
  if (!current) return;
  const S = current.svg;
  const groups = S.svgMasks.map(m => {
    let shapes = maskToShapes(m.mask, S.W, S.H, S.q, S.ox, S.oy);
    if (m.solid) shapes = shapes.filter(s => !shapes.some(o => o !== s && pointInPoly(s.outer[0], s.outer[1], o.outer))).map(s => ({ outer: s.outer, holes: [] }));
    return { ...m, shapes };
  });
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const gr of groups) for (const s of gr.shapes) { const b = bbox(s.outer); x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]); }
  const W = x1 - x0, H = y1 - y0, f = (v) => v.toFixed(3);
  const ring = (p) => { let d = ""; for (let i = 0; i < p.length; i += 2) d += (i ? "L" : "M") + f(p[i] - x0) + " " + f(y1 - p[i + 1]); return d + "Z"; };
  const body = groups.map(({ name, color, shapes }) =>
    `<g id="${name}" fill="${color}" fill-rule="evenodd" stroke="none">\n` +
    shapes.map(s => `<path d="${ring(s.outer)}${s.holes.map(ring).join("")}"/>`).join("\n") + "\n</g>").join("\n");
  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${f(W)}mm" height="${f(H)}mm" viewBox="0 0 ${f(W)} ${f(H)}">\n${body}\n</svg>\n`;
  saveBlob(new Blob([svg], { type: "image/svg+xml" }), baseName() + ".svg");
}

/* ------------------------------------------------------------ Anleitung */
function howto(res) {
  const steps = [];
  const inserts = res.parts.filter(p => p.insert);
  steps.push("Öffne die 3MF-Datei in Bambu Studio, Orca Slicer oder PrusaSlicer. Jede Ebene ist ihrem Filament-Platz schon zugeordnet; übernimmt dein Slicer das nicht, weise sie in der Objektliste zu.");
  const lines = [];
  const bed = res.baseT ? "die Basisplatte" : "aufs Druckbett";
  if (res.baseT) steps.push(`Alle Ebenen stehen auf einer ${de(res.baseT)} mm dicken Basisplatte` + (res.base.same ? " in der Farbe von Ebene 1." : "."));
  for (const L of res.layers.slice(1)) {
    const name = `Ebene ${L.k}`;
    if (L.insert) {
      const th = L.T - L.base;
      lines.push(`${name} ist ein Einlegeteil (${de(th)} mm dick)` + (L.mode === "stacked" ? ", es wird aufgeklebt."
        : L.mode === "through" ? `, die Aussparung geht ganz durch, Spiel ${de(L.clearance, 2)} mm.`
        : `, Aussparung ${de(L.embed)} mm tief, Spiel ${de(L.clearance, 2)} mm. Klemmt es, das Spiel erhöhen.`));
      continue;
    }
    const where = L.mode === "stacked" ? "liegt auf den Ebenen dahinter auf" : L.mode === "through" ? `reicht vor den Ebenen dahinter bis auf ${bed.replace("aufs ", "das ")}` : `sitzt ${de(L.embed)} mm tief in den Ebenen dahinter`;
    let s = `${name} ${where}`;
    if (L.freeBot !== undefined) s += L.freeBot <= 1e-3 ? `; wo nichts dahinter ist, reicht sie bis ${res.baseT ? "auf die Basisplatte" : "aufs Druckbett"}.` : `; wo nichts dahinter ist, beginnt sie erst in ${de(L.freeBot + res.baseT)} mm Höhe und braucht Stützen.`;
    else s += ".";
    lines.push(s);
  }
  steps.push(...lines);
  if (inserts.length) steps.push(`Die Einlegeteile liegen unter dem Schild flach auf dem Druckbett. Für getrennte Drucke in Bambu Studio weitere Platten anlegen und die Teile hinüberziehen. Mit Sekundenkleber oder 2K-Kleber einsetzen.`);
  const st = res.parts.find(p => p.stand);
  if (st) steps.push(`Zum Aufstellen: ${st.standInfo.kind === "two" ? "Die zwei Füße liegen" : "Der Ständer liegt"} unter dem Schild in der 3MF. Die Steckzunge unten an der Basisplatte in den Schlitz stecken (${de(st.standInfo.slot, 2)} mm breit, ${de(st.standInfo.depth)} mm tief, ${de(st.standInfo.angle, 0)}° nach hinten geneigt). Sitzt es zu stramm, das Spiel erhöhen.`);
  const needSupport = res.layers.some(L => !L.insert && L.freeBot > 1e-3);
  steps.push(needSupport ? "Schichthöhe 0,2 mm, 3 Wände, Stützen „Baum“ nur auf der Druckplatte." : "Schichthöhe 0,2 mm, 3 Wände, keine Stützen. Liegend drucken.");
  return steps;
}

/* ------------------------------------------------------------ Ablauf */
let current = null, busy = false, pending = false, timer = null, started = false;

async function run() {
  if (busy) { pending = true; return; }
  busy = true; pending = false;
  const status = $("#tStatus"), err = $("#tError");
  status.textContent = "Berechne …"; err.hidden = true;
  const t0 = performance.now();
  try {
    const P = params();
    const res = await generate(P);
    current = { ...res, P };
    $("#tEmpty").hidden = true; $("#tWrap").hidden = false; $("#tBox").classList.add("lit");
    resizeView();
    const size = showParts(res.parts);
    const keys = [];
    const slotOf = (p) => { const k = p.filament + "|" + p.color; if (!keys.includes(k)) keys.push(k); return keys.indexOf(k) + 1; };
    $("#tLegend").innerHTML = res.parts.map(p =>
      `<li><span class="sw" style="background:${p.color}"></span><span>Filament ${slotOf(p)}: ${esc(p.filament)}</span><span class="pc">${esc(p.name)}</span></li>`).join("");
    const tris = res.parts.reduce((s, p) => s + p.mesh.idx.length / 3, 0);
    $("#tStats").innerHTML = [["Größe", `${de(size.x)} × ${de(size.y)} × ${de(size.z)} mm`], ["Dreiecke", tris.toLocaleString("de-DE")]]
      .map(([k, v]) => `<span>${k} <b>${v}</b></span>`).join("");
    $("#tHowto").innerHTML = howto(res).map(s => `<li>${esc(s)}</li>`).join("");
    $("#tResult").hidden = false;
    hints();
    status.textContent = `Vorschau aktualisiert in ${Math.round(performance.now() - t0)} ms` + (res.reduced ? " · Auflösung wegen der Größe reduziert" : "");
  } catch (e) {
    console.error(e);
    err.textContent = e.message || String(e); err.hidden = false; status.textContent = "";
  } finally {
    busy = false; if (pending) run();
  }
}
const schedule = () => { clearTimeout(timer); timer = setTimeout(run, 350); };

function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("Konnte " + src + " nicht laden.")); document.head.appendChild(s); });
}

function hints() {
  const n = layerCount();
  for (let k = 1; k <= MAXL; k++) {
    $(`#t${k}Card`).hidden = k > n;
    const svg = (document.querySelector(`input[name=t${k}Kind]:checked`) || { value: "text" }).value === "svg";
    $(`#t${k}SvgBox`).hidden = !svg; $(`#t${k}TextBox`).hidden = svg;
    $(`#t${k}SpacingL`).hidden = svg;
  }
  for (let k = 2; k <= MAXL; k++) {
    const m = (document.querySelector(`input[name=t${k}Mode]:checked`) || { value: "embedded" }).value;
    const ins = $(`#t${k}Insert`).checked;
    $(`#t${k}EmbedRow`).hidden = m !== "embedded";
    $(`#t${k}ClearanceRow`).hidden = !ins;
    $(`#t${k}ToBedRow`).hidden = ins;
    $(`#t${k}DepthRow`).hidden = ins || $(`#t${k}ToBed`).checked;
  }
  const bOn = $("#tBaseOn").checked;
  $("#tBaseRow").hidden = !bOn;
  const shape = (document.querySelector("input[name=tBaseShape]:checked") || { value: "rect" }).value;
  $("#tBaseRadiusL").hidden = shape !== "rect";
  const same = $("#tBaseSame").checked;
  $("#tBaseColorL").hidden = same; $("#tBaseNameL").hidden = same;
  $("#tStandRow").hidden = !$("#tStandOn").checked;
  const fl = floating();
  const anyInsert = current ? current.parts.some(p => p.insert) : false;
  $("#tAssembly").disabled = fl;
  $("#tAssemblyRow").hidden = anyInsert;
  $("#tAssemblyHint").hidden = !fl;
}

function allFontSelects() { return $$("#modeText select[id$=Font]"); }

async function activate() {
  if (started) return;
  started = true;
  const anchor = $("#tOut");
  for (let k = 1; k <= MAXL; k++) anchor.insertAdjacentHTML("beforebegin", layerCard(k));
  for (const sel of allFontSelects()) fillFontSelect(sel, sel.dataset.def);
  FONTS.forEach(linkFont);
  try {
    if (!window.THREE) await loadScript(THREE_URL);
    if (!THREE.OrbitControls) await loadScript(ORBIT_URL);
  } catch (e) {
    $("#tError").textContent = "Die 3D-Vorschau braucht eine Internetverbindung (three.js vom CDN)."; $("#tError").hidden = false;
    started = false; return;
  }
  initView();
  $$("#tForm input, #tForm select").forEach(el => {
    if (["tName", "tGfName", "tFontFile", "tSvgFile", "tAssembly"].includes(el.id)) return;
    el.addEventListener("input", schedule);
    el.addEventListener("change", () => { hints(); schedule(); });
  });
  hints();
  $("#tForm").addEventListener("submit", (e) => { e.preventDefault(); download3mf(); });
  $("#tSvg").addEventListener("click", downloadSvg);
  $$("[data-tupload]").forEach(b => b.addEventListener("click", () => { uploadTarget = b.dataset.tupload; $("#tFontFile").value = ""; $("#tFontFile").click(); }));
  $("#tFontFile").addEventListener("change", (e) => { const f = e.target.files[0]; if (f) addFontFile(f); });
  $$("[data-tsvg]").forEach(b => b.addEventListener("click", () => { svgTarget = b.dataset.tsvg; $("#tSvgFile").value = ""; $("#tSvgFile").click(); }));
  $("#tSvgFile").addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const k = svgTarget;
    try {
      const S = await loadSvgFile(f, k);
      $(`#t${k}SvgName`).textContent = `${S.name} · Seitenverhältnis ${de((S.ink.x1 - S.ink.x0) * S.vbW / ((S.ink.y1 - S.ink.y0) * S.vbH), 2)} : 1`;
      const r = document.querySelector(`input[name=t${k}Kind][value=svg]`); if (r) r.checked = true;
      hints(); schedule();
    } catch (ex) { $("#tError").textContent = ex.message; $("#tError").hidden = false; }
  });
  $("#tGfAdd").addEventListener("click", addGoogleFont);
  $("#tGfName").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addGoogleFont(); } });
  run();
}

let uploadTarget = "1", svgTarget = "1";
async function addFontFile(file) {
  try {
    const fam = "Eigene – " + file.name.replace(/\.[^.]+$/, "");
    const ff = new FontFace(fam, await file.arrayBuffer());
    await ff.load(); document.fonts.add(ff);
    const o = { f: fam, w: 400, g: "Eigene Schriften", custom: true };
    fontMap.set(fontKey(o), o);
    for (const sel of allFontSelects()) fillFontSelect(sel);
    $(`#t${uploadTarget}Font`).value = fontKey(o);
    schedule();
  } catch (e) { $("#tError").textContent = "Die Schriftdatei konnte nicht gelesen werden."; $("#tError").hidden = false; }
}
async function addGoogleFont() {
  const name = $("#tGfName").value.trim(); if (!name) return;
  const o = { f: name, w: 400, g: "Hinzugefügt" };
  const hint = $("#tGfHint");
  hint.textContent = "Lade …";
  const ok = (await linkFont(o)) && await Promise.race([
    document.fonts.load(`400 100px "${name}"`).then(r => r.length > 0).catch(() => false),
    new Promise(r => setTimeout(() => r(false), 6000))]);
  if (!ok) { linked.delete(fontKey(o)); hint.textContent = `„${name}“ gibt es bei Google Fonts nicht (genaue Schreibweise beachten).`; return; }
  fontMap.set(fontKey(o), o);
  for (const sel of allFontSelects()) fillFontSelect(sel);
  hint.textContent = `„${name}“ steht jetzt in allen Schriftlisten.`;
  $("#tGfName").value = "";
}

window.Schriftzug = { activate };
// gemeinsame Werkzeuge für den Ambigramm-Reiter
window.Werkstatt = { FONTS, fontMap, fontKey, linkFont, loadFont, fillFontSelect, maskToShapes, loadScript, THREE_URL, ORBIT_URL, de, esc };
if (!$("#modeText").hidden) activate();
})();

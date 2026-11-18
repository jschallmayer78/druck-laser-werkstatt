/* Schriftzug – zwei Textzeilen als 3D-Druck-Modell.
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

// Maße in mm, unabhängig von der Rasterauflösung
function measureLine(L) {
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

/* ------------------------------------------------------------ Generierung */
const num = (id, d) => { const v = parseFloat($("#" + id).value); return isFinite(v) ? v : d; };
function params() {
  return {
    bg: { text: $("#tBgText").value, font: fontMap.get($("#tBgFont").value), height: num("tBgHeight", 50),
          thick: Math.max(0.4, num("tBgThick", 5)), spacing: num("tBgSpacing", 0), grow: Math.max(0, num("tBgGrow", 0)),
          color: $("#tBgColor").value.toUpperCase(), filament: $("#tBgName").value.trim() || "Hintergrund" },
    fg: { text: $("#tFgText").value, font: fontMap.get($("#tFgFont").value), height: num("tFgHeight", 30),
          over: Math.max(0, num("tFgOver", 2)), embed: Math.max(0, num("tFgEmbed", 2)),
          toBed: $("#tFgToBed").checked, depth: Math.max(0.4, num("tFgDepth", 4)),
          insert: $("#tInsert").checked, clearance: Math.max(0, num("tClearance", 0.15)), x: num("tFgX", 0), y: num("tFgY", 0), spacing: num("tFgSpacing", 0),
          grow: Math.max(0, num("tFgGrow", 0)), rim: Math.max(0, num("tFgRim", 0)),
          color: $("#tFgColor").value.toUpperCase(), filament: $("#tFgName").value.trim() || "Vordergrund" },
    mode: document.querySelector("input[name=tMode]:checked").value,
    q: num("tQuality", 10),
  };
}

async function generate(P) {
  await Promise.all([loadFont(P.bg.font, P.bg.text), loadFont(P.fg.font, P.fg.text)]);
  const MB = measureLine(P.bg), MF = measureLine(P.fg);
  if (!MB && !MF) throw new Error("Bitte mindestens eine Textzeile eingeben.");
  // Einbettungstiefe: 0 = aufgesetzt, volle Dicke = durchgehend ab Druckbett
  const T = P.bg.thick;
  const embed = P.mode === "stacked" ? 0 : P.mode === "through" ? T : Math.min(T, Math.max(0, P.fg.embed));
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  const ext = (cx, cy, w, h, m) => { x0 = Math.min(x0, cx - w / 2 - m); x1 = Math.max(x1, cx + w / 2 + m); y0 = Math.min(y0, cy - h / 2 - m); y1 = Math.max(y1, cy + h / 2 + m); };
  if (MB) ext(0, 0, MB.w, MB.h, P.bg.grow);
  if (MF) ext(P.fg.x, P.fg.y, MF.w, MF.h, P.fg.grow + P.fg.rim);
  const pad = 1.5 + Math.max(MB ? MB.h : 0, MF ? MF.h : 0) * 0.08;   // Reserve für Glyphen-Überhänge
  x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  let q = P.q;
  const maxPix = 24e6;
  if ((x1 - x0) * (y1 - y0) * q * q > maxPix) q = Math.sqrt(maxPix / ((x1 - x0) * (y1 - y0)));
  const W = Math.ceil((x1 - x0) * q), H = Math.ceil((y1 - y0) * q);
  const ox = -x0 * q, oy = y1 * q;
  const mk = () => { const c = document.createElement("canvas"); c.width = W; c.height = H; const g = c.getContext("2d", { willReadFrequently: true }); g.fillStyle = "#000"; g.strokeStyle = "#000"; return g; };
  // Masken:
  //   g0    große Buchstaben
  //   gf    kleine Zeile
  //   gfree kleine Zeile, soweit sie NICHT vor einem großen Buchstaben liegt
  //   gs    Hintergrund unterhalb der Vertiefung: große Buchstaben + Rand, ohne gfree
  //   gb    Hintergrund oberhalb (mit Aussparung): große Buchstaben + Rand, ohne gf
  // Wo die kleine Zeile über die großen Buchstaben hinausragt, reicht sie bis
  // aufs Druckbett; nur vor einem Buchstaben sitzt sie auf Hintergrundmaterial.
  const g0 = mk(), gf = mk(), gfree = mk(), gs = mk(), gb = mk();
  const bx = ox, by = oy, fx = ox + P.fg.x * q, fy = oy - P.fg.y * q;
  const cutOut = (g, src) => { g.globalCompositeOperation = "destination-out"; g.drawImage(src.canvas, 0, 0); g.globalCompositeOperation = "source-over"; };

  if (MB) drawLine(g0, P.bg, MB, q, bx, by, P.bg.grow);
  if (MF) {
    drawLine(gf, P.fg, MF, q, fx, fy, P.fg.grow);
    drawLine(gfree, P.fg, MF, q, fx, fy, P.fg.grow);
    cutOut(gfree, g0);
  }
  for (const g of [gb, gs]) {
    if (MB) drawLine(g, P.bg, MB, q, bx, by, P.bg.grow);
    if (MF && P.fg.rim > 0) drawLine(g, P.fg, MF, q, fx, fy, P.fg.grow + P.fg.rim);   // Rand
  }
  if (MF && P.fg.insert) {
    // Einlegeteil: Aussparung mit Spiel in die großen Buchstaben, darunter voller Boden
    for (const g of [gb, gs]) g.clearRect(0, 0, W, H);
    for (const g of [gb, gs]) {
      if (MB) drawLine(g, P.bg, MB, q, bx, by, P.bg.grow);
      if (P.fg.rim > 0) drawLine(g, P.fg, MF, q, fx, fy, P.fg.grow + P.fg.rim);
    }
    const gc = mk();
    drawLine(gc, P.fg, MF, q, fx, fy, P.fg.grow + P.fg.clearance);
    cutOut(gb, gc);
  } else if (MF) { cutOut(gb, gf); cutOut(gs, gfree); }
  const alphaOf = (g) => {
    const d = g.getImageData(0, 0, W, H).data, a = new Uint8Array(W * H);
    for (let i = 0, j = 3; i < a.length; i++, j += 4) a[i] = d[j];
    for (let i = 0; i < W; i++) { a[i] = 0; a[(H - 1) * W + i] = 0; }
    for (let j = 0; j < H; j++) { a[j * W] = 0; a[j * W + W - 1] = 0; }
    return a;
  };
  const split = MF ? T - embed : T;                 // Höhe, ab der die Vertiefung beginnt
  const fgZ1 = T + (embed === 0 ? Math.max(0.2, P.fg.over) : P.fg.over);
  const parts = [];
  {
    // unten voll (trägt die kleine Zeile), oben mit Aussparung
    const meshes = [];
    const cut = MF && split < T - 1e-6 ? maskToShapes(alphaOf(gb), W, H, q, ox, oy) : null;
    const full = split > 1e-6 ? maskToShapes(alphaOf(MF ? gs : gb), W, H, q, ox, oy) : null;   // ohne kleine Zeile: gb == gs
    if (full && full.length) meshes.push(extrude(full, 0, split));
    if (cut && cut.length) meshes.push(extrude(cut, split, T));
    const mesh = mergeMeshes(meshes.filter(Boolean));
    if (mesh) parts.push({ name: "Hintergrund", filament: P.bg.filament, color: P.bg.color, shapes: (cut && cut.length) ? cut : full, mesh });
  }
  // Unterkante der kleinen Zeile außerhalb der großen Buchstaben:
  // Druckbett oder eigene Tiefe (gemessen von ihrer Oberseite)
  const fb = P.fg.toBed ? 0 : Math.min(fgZ1 - 0.2, Math.max(0, fgZ1 - P.fg.depth));
  let freeArea = false;
  if (MF && P.fg.insert) {
    // flaches Einlegeteil; in der Vorschau eingesetzt, in der 3MF daneben auf dem Druckbett
    const shapes = maskToShapes(alphaOf(gf), W, H, q, ox, oy);
    const mesh = extrude(shapes, split, fgZ1);
    if (mesh) {
      let fgMaxY = -1e9, bgMinY = 1e9;
      for (const s of shapes) fgMaxY = Math.max(fgMaxY, bbox(s.outer)[3]);
      for (const s of (parts[0] ? parts[0].shapes : [])) bgMinY = Math.min(bgMinY, bbox(s.outer)[1]);
      const dy = parts.length ? bgMinY - fgMaxY - 10 : 0;
      parts.push({ name: "Einlegeteil", filament: P.fg.filament, color: P.fg.color, shapes, mesh, exportOffset: [0, dy, -split] });
    }
  } else if (MF) {
    // Lagen übereinander, der Server vereinigt sie zu einem Körper:
    //   vor den Buchstaben: Boden der Vertiefung (split) bis Oberkante
    //   außerhalb:          fb bis Oberkante
    const meshes = [];
    const shapes = maskToShapes(alphaOf(gf), W, H, q, ox, oy);
    const free = maskToShapes(alphaOf(gfree), W, H, q, ox, oy);
    freeArea = free.length > 0;
    if (fb < split - 1e-6) {
      if (free.length) meshes.push(extrude(free, fb, split));
      if (shapes.length) meshes.push(extrude(shapes, split, fgZ1));
    } else if (fb > split + 1e-6) {
      const gover = mk();
      gover.drawImage(gf.canvas, 0, 0); cutOut(gover, gfree);
      const over = maskToShapes(alphaOf(gover), W, H, q, ox, oy);
      if (over.length) meshes.push(extrude(over, split, fb));
      if (shapes.length) meshes.push(extrude(shapes, fb, fgZ1));
    } else if (shapes.length) {
      meshes.push(extrude(shapes, split, fgZ1));
    }
    const mesh = mergeMeshes(meshes.filter(Boolean));
    if (mesh) parts.push({ name: "Vordergrund", filament: P.fg.filament, color: P.fg.color, shapes, mesh });
  }
  if (!parts.length) throw new Error("Aus dem Text ist keine druckbare Fläche entstanden.");
  return { parts, q, reduced: q < P.q - 0.01, embed, fb, freeArea, insert: !!(MF && P.fg.insert), split, fgZ1 };
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

// Exportlage: das Einlegeteil liegt neben dem Schild flach auf dem Druckbett
function shifted(p) {
  if (!p.exportOffset) return p.mesh.pos;
  const [dx, dy, dz] = p.exportOffset, out = new Float32Array(p.mesh.pos.length);
  for (let i = 0; i < out.length; i += 3) { out[i] = p.mesh.pos[i] + dx; out[i + 1] = p.mesh.pos[i + 1] + dy; out[i + 2] = p.mesh.pos[i + 2] + dz; }
  return out;
}

async function download3mf() {
  if (!current) return;
  const err = $("#tError"); err.hidden = true;
  const go = $("#tGo"); go.disabled = true; go.textContent = "3MF wird gepackt …";
  try {
    const body = {
      title: baseName(), separate: current.insert || (!$("#tAssembly").checked && !floating()), thumbnail: thumbnail(),
      parts: current.parts.map(p => ({ name: p.name, filament: p.filament, color: p.color, verts: b64(shifted(p)), faces: b64(p.mesh.idx), layers: p.mesh.layers || null })),
    };
    const r = await fetch("api/schriftzug", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(typeof j.detail === "string" ? j.detail : "Die 3MF konnte nicht erzeugt werden."); }
    saveBlob(await r.blob(), baseName() + ".3mf");
    $("#t4").classList.add("done");
  } catch (ex) {
    err.textContent = ex.message === "Failed to fetch" ? "Der Server ist nicht erreichbar." : ex.message; err.hidden = false;
  } finally { go.disabled = false; go.textContent = "3MF herunterladen"; }
}

// SVG mit beiden Ebenen in ihren Farben (LightBurn legt je Farbe eine Ebene an)
function downloadSvg() {
  if (!current) return;
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const p of current.parts) for (const s of p.shapes) { const b = bbox(s.outer); x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]); }
  const W = x1 - x0, H = y1 - y0, f = (v) => v.toFixed(3);
  const ring = (p) => { let d = ""; for (let i = 0; i < p.length; i += 2) d += (i ? "L" : "M") + f(p[i] - x0) + " " + f(y1 - p[i + 1]); return d + "Z"; };
  const groups = current.parts.map(p =>
    `<g id="${p.name}" fill="${p.color}" fill-rule="evenodd" stroke="none">\n` +
    p.shapes.map(s => `<path d="${ring(s.outer)}${s.holes.map(ring).join("")}"/>`).join("\n") + "\n</g>").join("\n");
  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${f(W)}mm" height="${f(H)}mm" viewBox="0 0 ${f(W)} ${f(H)}">\n${groups}\n</svg>\n`;
  saveBlob(new Blob([svg], { type: "image/svg+xml" }), baseName() + ".svg");
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
    $("#tLegend").innerHTML = res.parts.map((p, i) =>
      `<li><span class="sw" style="background:${p.color}"></span><span>Filament ${i + 1}: ${esc(p.filament)}</span><span class="pc">${p.name}</span></li>`).join("");
    const tris = res.parts.reduce((s, p) => s + p.mesh.idx.length / 3, 0);
    $("#tStats").innerHTML = [["Größe", `${de(size.x)} × ${de(size.y)} × ${de(size.z)} mm`], ["Dreiecke", tris.toLocaleString("de-DE")]]
      .map(([k, v]) => `<span>${k} <b>${v}</b></span>`).join("");
    const e = res.embed;
    const fgPart = res.parts.find(p => p.name !== "Hintergrund");
    const fgOnBed = fgPart && res.freeArea && res.fb <= 1e-3;
    const steps = res.insert ? [
      "Die 3MF enthält zwei Objekte: das Schild mit Aussparung und daneben das flache Einlegeteil. Für getrennte Drucke in Bambu Studio eine zweite Platte anlegen und das Einlegeteil hinüberziehen.",
      `Einlegeteil ${de(res.fgZ1 - res.split)} mm dick, ` + (res.split < P.bg.thick - 1e-6
        ? (res.split > 1e-6 ? `Aussparung ${de(P.bg.thick - res.split)} mm tief` : "Aussparung geht ganz durch")
        : "keine Aussparung, das Teil wird aufgeklebt") + (res.split < P.bg.thick - 1e-6 ? `, Spiel ${de(P.fg.clearance, 2)} mm je Seite. Klemmt es, das Spiel erhöhen.` : "."),
      "Beide Teile liegend mit der Oberseite nach oben drucken, keine Stützen. Das Einlegeteil mit Sekundenkleber oder 2K-Kleber einsetzen.",
    ] : [
      "Öffne die 3MF-Datei in Bambu Studio, Orca Slicer oder PrusaSlicer. Die Teile sind ihren Filament-Plätzen schon zugeordnet; übernimmt dein Slicer das nicht, weise sie in der Objektliste zu.",
      e >= P.bg.thick - 1e-6 ? "Beide Teile stehen auf dem Druckbett, der Hintergrund ist unter der kleinen Zeile ausgespart."
        : fgOnBed ? (e === 0 ? "Die kleine Zeile liegt auf den großen Buchstaben auf." : `Vor den großen Buchstaben sitzt die kleine Zeile ${de(e)} mm tief.`)
            + " Wo sie über die Buchstaben hinausragt, reicht sie bis aufs Druckbett."
        : e === 0 ? "Die kleine Zeile liegt oben auf: Farbwechsel gibt es nur in den obersten Schichten, das spart Spülmaterial."
        : `Die kleine Zeile sitzt ${de(e)} mm tief im Hintergrund. Farbwechsel beginnen erst ab ${de(P.bg.thick - e)} mm Höhe.`,
      res.freeArea && res.fb > 1e-3
        ? `Außerhalb der großen Buchstaben beginnt die kleine Zeile erst in ${de(res.fb)} mm Höhe und hängt in der Luft: im Slicer Stützen aktivieren (z. B. „Baum“, nur auf Druckplatte). Schichthöhe 0,2 mm, 3 Wände.`
        : "Schichthöhe 0,2 mm, 3 Wände, keine Stützen. Liegend drucken.",
    ];
    $("#tHowto").innerHTML = steps.map(s => `<li>${esc(s)}</li>`).join("");
    $("#tResult").hidden = false;
    modeHint();
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

async function activate() {
  if (started) return;
  started = true;
  fillFontSelect($("#tBgFont"), "Anton|400");
  fillFontSelect($("#tFgFont"), "Pacifico|400");
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
    if (["tName", "tGfName", "tFontFile", "tAssembly"].includes(el.id)) return;
    el.addEventListener("input", schedule);
    el.addEventListener("change", schedule);
  });
  $$("input[name=tMode]").forEach(el => el.addEventListener("change", modeHint));
  $("#tBgThick").addEventListener("input", modeHint);
  $("#tFgText").addEventListener("input", modeHint);
  $("#tFgToBed").addEventListener("change", modeHint);
  $("#tInsert").addEventListener("change", modeHint);
  modeHint();
  $("#tForm").addEventListener("submit", (e) => { e.preventDefault(); download3mf(); });
  $("#tSvg").addEventListener("click", downloadSvg);
  $$("[data-tupload]").forEach(b => b.addEventListener("click", () => { uploadTarget = b.dataset.tupload; $("#tFontFile").value = ""; $("#tFontFile").click(); }));
  $("#tFontFile").addEventListener("change", (e) => { const f = e.target.files[0]; if (f) addFontFile(f); });
  $("#tGfAdd").addEventListener("click", addGoogleFont);
  $("#tGfName").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addGoogleFont(); } });
  run();
}
// Beginnt ein Teil über dem Druckbett, muss alles ein Objekt sein: Slicer setzen
// jedes Objekt beim Laden auf die Druckplatte und würden die kleine Zeile absenken.
function minZ(mesh) { let z = Infinity; for (let i = 2; i < mesh.pos.length; i += 3) if (mesh.pos[i] < z) z = mesh.pos[i]; return z; }
function floating() {
  return !!current && current.parts.some(p => minZ(p.mesh) > 1e-3);
}
function modeHint() {
  const m = document.querySelector("input[name=tMode]:checked").value;
  const fl = floating();
  $("#tAssembly").disabled = fl;
  const ins = $("#tInsert").checked;
  $("#tClearanceRow").hidden = !ins;
  $("#tFgToBedRow").hidden = ins;
  $("#tFgDepthRow").hidden = ins || $("#tFgToBed").checked;
  $("#tAssemblyRow").hidden = ins;
  $("#tAssemblyHint").hidden = !fl || $("#tInsert").checked;
  $("#tEmbedRow").hidden = m !== "embedded";
  $("#tFgEmbed").max = String(num("tBgThick", 5));
  $("#tModeHint").textContent = {
    stacked: "Vor den großen Buchstaben liegt die kleine Zeile oben auf.",
    embedded: "Die Einbettungstiefe zählt von der Oberseite der großen Buchstaben nach unten, höchstens bis zu ihrer Dicke.",
    through: "Vor den großen Buchstaben reicht die kleine Zeile durch den ganzen Hintergrund bis aufs Druckbett.",
  }[m];
}

let uploadTarget = "Bg";
async function addFontFile(file) {
  try {
    const fam = "Eigene – " + file.name.replace(/\.[^.]+$/, "");
    const ff = new FontFace(fam, await file.arrayBuffer());
    await ff.load(); document.fonts.add(ff);
    const o = { f: fam, w: 400, g: "Eigene Schriften", custom: true };
    fontMap.set(fontKey(o), o);
    fillFontSelect($("#tBgFont")); fillFontSelect($("#tFgFont"));
    $("#t" + uploadTarget + "Font").value = fontKey(o);
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
  fillFontSelect($("#tBgFont")); fillFontSelect($("#tFgFont"));
  hint.textContent = `„${name}“ steht jetzt in beiden Listen.`;
  $("#tGfName").value = "";
}

window.Schriftzug = { activate };
if (!$("#modeText").hidden) activate();
})();

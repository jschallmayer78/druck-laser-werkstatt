/* Ambigramm – zwei Wörter, aus zwei Richtungen lesbar.
 *
 * Der Browser rendert jeden Buchstaben (gleiche Höhe für alle) und schickt die
 * Umrisse an den Server (POST api/ambigramm). Dort entsteht je Buchstabenpaar
 * die Schnittmenge der beiden Extrusionen; zurück kommt ein Vorschau-Netz
 * oder die 3MF-Datei. Schriften und Umriss-Erkennung kommen aus schriftzug.js.
 */
(() => {
"use strict";
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const W = () => window.Werkstatt;

/* ------------------------------------------------------------ Buchstaben-Umrisse */
const glyphCache = new Map();
function glyph(ch, font, H) {
  const key = ch + "|" + W().fontKey(font) + "|" + H;
  if (glyphCache.has(key)) return glyphCache.get(key);
  const q = Math.max(8, Math.min(24, 1200 / H));          // Pixel je mm
  const c = document.createElement("canvas"), g = c.getContext("2d", { willReadFrequently: true });
  const REF = 200;
  g.font = `${font.w} ${REF}px "${font.f}"`;
  const m0 = g.measureText(ch);
  const inkH = m0.actualBoundingBoxAscent + m0.actualBoundingBoxDescent;
  if (!(inkH > 0)) { glyphCache.set(key, null); return null; }
  const fpx = REF * H * q / inkH;
  g.font = `${font.w} ${fpx}px "${font.f}"`;
  const m = g.measureText(ch);
  const iw = m.actualBoundingBoxLeft + m.actualBoundingBoxRight, ih = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
  const pad = 4;
  c.width = Math.ceil(iw + 2 * pad); c.height = Math.ceil(ih + 2 * pad);
  g.font = `${font.w} ${fpx}px "${font.f}"`;
  g.fillStyle = "#000"; g.textBaseline = "alphabetic"; g.textAlign = "left";
  g.fillText(ch, pad + m.actualBoundingBoxLeft, pad + m.actualBoundingBoxAscent);
  const d = g.getImageData(0, 0, c.width, c.height).data, a = new Uint8Array(c.width * c.height);
  for (let i = 0, j = 3; i < a.length; i++, j += 4) a[i] = d[j];
  // Ursprung: linke Tintenkante, Unterkante
  const shapes = W().maskToShapes(a, c.width, c.height, q, pad, pad + ih);
  // exakt auf 0 … H normieren (Kantenglättung verschiebt die Kontur um Bruchteile eines Pixels)
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const sh of shapes) for (const p of [sh.outer, ...sh.holes]) for (let i = 0; i < p.length; i += 2) {
    if (p[i] < x0) x0 = p[i]; if (p[i] > x1) x1 = p[i]; if (p[i + 1] < y0) y0 = p[i + 1]; if (p[i + 1] > y1) y1 = p[i + 1];
  }
  if (!shapes.length || !(y1 > y0)) { glyphCache.set(key, null); return null; }
  const k = H / (y1 - y0);
  const rings = [];
  const toRing = (p) => { const r = []; for (let i = 0; i < p.length; i += 2) r.push([+((p[i] - x0) * k).toFixed(4), +((p[i + 1] - y0) * k).toFixed(4)]); return r; };
  for (const sh of shapes) { rings.push(toRing(sh.outer)); for (const h of sh.holes) rings.push(toRing(h)); }
  const res = { rings, w: (x1 - x0) * k };
  glyphCache.set(key, res);
  return res;
}

function params() {
  const v = (id, d) => { const x = parseFloat($("#" + id).value); return isFinite(x) ? x : d; };
  return {
    w1: $("#aWord1").value, w2: $("#aWord2").value, upper: $("#aUpper").checked,
    font: W().fontMap.get($("#aFont").value) || W().FONTS[0],
    height: Math.max(5, v("aHeight", 30)), gap: v("aGap", 2),
    base_on: $("#aBaseOn").checked, base_thick: Math.max(0.4, v("aBaseThick", 3)), base_margin: Math.max(0, v("aBaseMargin", 3)),
    same_color: $("#aSame").checked,
    letter_color: $("#aColor").value.toUpperCase(), letter_filament: $("#aName").value.trim() || "Buchstaben",
    base_color: $("#aBaseColor").value.toUpperCase(), base_filament: $("#aBaseName").value.trim() || "Sockel",
  };
}

async function request(P, format, thumbnail) {
  let a = [...P.w1.trim()], b = [...P.w2.trim()];
  if (P.upper) { a = a.map(c => c.toLocaleUpperCase("de-DE")); b = b.map(c => c.toLocaleUpperCase("de-DE")); }
  // „ß“ wird groß zu „SS“ – Zeichen erneut aufteilen
  a = [...a.join("")]; b = [...b.join("")];
  if (!a.length || !b.length) throw new Error("Bitte beide Wörter eingeben.");
  if (a.length !== b.length) throw new Error(`Beide Wörter brauchen gleich viele Zeichen (Wort 1: ${a.length}, Wort 2: ${b.length}). Leerzeichen zählen mit.`);
  await W().loadFont(P.font, a.join("") + b.join(""));
  const letters = [];
  for (let i = 0; i < a.length; i++) {
    const sa = a[i] === " ", sb = b[i] === " ";
    if (sa || sb) {
      if (sa !== sb) throw new Error(`Leerzeichen müssen in beiden Wörtern an derselben Stelle stehen (Stelle ${i + 1}).`);
      letters.push({ a: " ", b: " ", space: true, wf: P.height * 0.4, ws: P.height * 0.4 });
      continue;
    }
    const ga = glyph(a[i], P.font, P.height), gb = glyph(b[i], P.font, P.height);
    if (!ga) throw new Error(`Für „${a[i]}“ hat die Schrift keinen Buchstaben.`);
    if (!gb) throw new Error(`Für „${b[i]}“ hat die Schrift keinen Buchstaben.`);
    letters.push({ a: a[i], b: b[i], front: ga.rings, side: gb.rings, wf: ga.w, ws: gb.w });
  }
  const body = {
    title: ($("#aFile").value.trim() || "ambigramm"), letters, gap: P.gap,
    base_on: P.base_on, base_thick: P.base_thick, base_margin: P.base_margin, same_color: P.same_color,
    letter_color: P.letter_color, letter_filament: P.letter_filament, base_color: P.base_color, base_filament: P.base_filament,
    format, thumbnail: thumbnail || null,
  };
  const r = await fetch("api/ambigramm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    const msg = typeof j.detail === "string" ? j.detail : Array.isArray(j.detail) ? "Eingabe ungültig: " + (j.detail[0]?.msg || "") : "Der Server konnte das Ambigramm nicht berechnen.";
    throw new Error(msg);
  }
  return format === "mesh" ? r.json() : r.blob();
}

/* ------------------------------------------------------------ Vorschau */
let renderer, scene, camera, persp, ortho, controls, group, view = "iso", elView;
function initView() {
  const el = $("#aView");
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  el.appendChild(renderer.domElement);
  scene = new THREE.Scene();
  elView = el;
  persp = new THREE.PerspectiveCamera(30, 1, 1, 20000); persp.up.set(0, 0, 1);
  ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 20000); ortho.up.set(0, 0, 1);
  camera = persp;
  controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445066, 0.8));
  const d1 = new THREE.DirectionalLight(0xffffff, 0.7); d1.position.set(-1, -2, 3); scene.add(d1);
  const d2 = new THREE.DirectionalLight(0xffe2b0, 0.35); d2.position.set(2, 1, 1.5); scene.add(d2);
  group = new THREE.Group(); scene.add(group);
  const resize = () => { const w = el.clientWidth, h = el.clientHeight; if (!w || !h) return; renderer.setSize(w, h); persp.aspect = w / h; persp.updateProjectionMatrix(); if (group && group.children.length) setView(view); };
  new ResizeObserver(resize).observe(el); resize();
  (function loop() { requestAnimationFrame(loop); controls.update(); renderer.render(scene, camera); })();
}
function decode(b64, T) { const s = atob(b64), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return new T(u.buffer); }
function showParts(parts) {
  while (group.children.length) { const c = group.children.pop(); c.geometry.dispose(); c.material.dispose(); }
  for (const p of parts) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(decode(p.verts, Float32Array), 3));
    g.setIndex(new THREE.BufferAttribute(decode(p.faces, Uint32Array), 1));
    const ng = g.toNonIndexed(); ng.computeVertexNormals(); g.dispose();
    group.add(new THREE.Mesh(ng, new THREE.MeshStandardMaterial({ color: p.color, roughness: 0.55, metalness: 0.02 })));
  }
  setView(view);
}
function setView(v) {
  view = v;
  $$("[data-aview]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.aview === v)));
  const box = new THREE.Box3().setFromObject(group);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  const aspect = Math.max(0.2, (elView.clientWidth || 1) / (elView.clientHeight || 1));
  const R = size.length() / 2;
  if (v === "front" || v === "side") {
    // Parallelprojektion: so sieht man das Wort ohne perspektivische Verzerrung
    const wv = v === "front" ? size.x : size.y, hv = size.z;
    const half = Math.max(wv / aspect, hv) / 2 * 1.12;
    ortho.left = -half * aspect; ortho.right = half * aspect; ortho.top = half; ortho.bottom = -half;
    ortho.near = 0.1; ortho.far = R * 10;
    camera = ortho;
    if (v === "front") camera.position.set(c.x, c.y - R * 3, c.z); else camera.position.set(c.x + R * 3, c.y, c.z);
    ortho.zoom = 1; ortho.updateProjectionMatrix();
  } else {
    camera = persp;
    const D = R / Math.sin(THREE.MathUtils.degToRad(persp.fov / 2)) * 0.9;
    camera.position.set(c.x + D * 0.55, c.y - D * 0.6, c.z + D * 0.55);
    persp.near = Math.max(0.5, D / 200); persp.far = D * 50; persp.updateProjectionMatrix();
  }
  controls.object = camera;
  controls.target.copy(c);
  controls.update();
}
function thumbnail() {
  try {
    renderer.render(scene, camera);
    const src = renderer.domElement, s = 256, c = document.createElement("canvas"); c.width = s; c.height = s;
    const g = c.getContext("2d"), k = Math.min(s / src.width, s / src.height);
    g.drawImage(src, (s - src.width * k) / 2, (s - src.height * k) / 2, src.width * k, src.height * k);
    return c.toDataURL("image/png");
  } catch (e) { return null; }
}

/* ------------------------------------------------------------ Ablauf */
let busy = false, pending = false, timer = null, started = false, ok = false;
async function run() {
  if (busy) { pending = true; return; }
  busy = true; pending = false;
  const err = $("#aError"), st = $("#aStatus");
  err.hidden = true; st.textContent = "Berechne …";
  const t0 = performance.now();
  try {
    const P = params();
    const res = await request(P, "mesh");
    $("#aEmpty").hidden = true; $("#aWrap").hidden = false; $("#aBox").classList.add("lit");
    window.dispatchEvent(new Event("resize"));
    showParts(res.parts);
    const wl = $("#aWarn");
    wl.innerHTML = res.warnings.map(w => `<li>${W().esc(w)}</li>`).join("");
    $("#aWarnBox").hidden = !res.warnings.length;
    const box = new THREE.Box3().setFromObject(group), size = box.getSize(new THREE.Vector3());
    $("#aStats").innerHTML = [["Größe", `${W().de(size.x)} × ${W().de(size.y)} × ${W().de(size.z)} mm`]]
      .map(([k, v]) => `<span>${k} <b>${v}</b></span>`).join("");
    const keys = [];
    $("#aLegend").innerHTML = res.parts.map(p => {
      const k = p.filament + "|" + p.color; if (!keys.includes(k)) keys.push(k);
      return `<li><span class="sw" style="background:${p.color}"></span><span>Filament ${keys.indexOf(k) + 1}: ${W().esc(p.filament)}</span><span class="pc">${W().esc(p.name)}</span></li>`;
    }).join("");
    $("#aResult").hidden = false;
    ok = true;
    st.textContent = `Vorschau aktualisiert in ${Math.round(performance.now() - t0)} ms`;
  } catch (e) {
    ok = false;
    err.textContent = e.message === "Failed to fetch" ? "Der Server ist nicht erreichbar." : e.message; err.hidden = false; st.textContent = "";
  } finally { busy = false; if (pending) run(); }
}
const schedule = () => { clearTimeout(timer); timer = setTimeout(run, 400); };

async function download() {
  if (!ok) return;
  const go = $("#aGo"), err = $("#aError"); go.disabled = true; go.textContent = "3MF wird gepackt …"; err.hidden = true;
  try {
    const blob = await request(params(), "3mf", thumbnail());
    const name = ($("#aFile").value.trim() || "ambigramm").replace(/[\\/:*?"<>|]+/g, "_") + ".3mf";
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    $("#a4").classList.add("done");
  } catch (e) { err.textContent = e.message; err.hidden = false; }
  finally { go.disabled = false; go.textContent = "3MF herunterladen"; }
}

function hints() {
  $("#aBaseRow").hidden = !$("#aBaseOn").checked;
  const same = $("#aSame").checked;
  $("#aBaseColorL").hidden = same; $("#aBaseNameL").hidden = same;
}

async function activate() {
  if (started) return;
  if (!window.Werkstatt) { setTimeout(activate, 100); return; }
  started = true;
  W().fillFontSelect($("#aFont"), "Archivo Black|400");
  W().FONTS.forEach(W().linkFont);
  try {
    if (!window.THREE) await W().loadScript(W().THREE_URL);
    if (!THREE.OrbitControls) await W().loadScript(W().ORBIT_URL);
  } catch (e) {
    $("#aError").textContent = "Die 3D-Vorschau braucht eine Internetverbindung (three.js vom CDN)."; $("#aError").hidden = false;
    started = false; return;
  }
  initView();
  $$("#aForm input, #aForm select").forEach(el => {
    if (el.id === "aFile") return;
    el.addEventListener("input", schedule);
    el.addEventListener("change", () => { hints(); schedule(); });
  });
  $$("[data-aview]").forEach(b => b.addEventListener("click", () => setView(b.dataset.aview)));
  $("#aForm").addEventListener("submit", (e) => { e.preventDefault(); download(); });
  hints();
  run();
}
window.Ambigramm = { activate };
if (!$("#modeAmbi").hidden) activate();
})();

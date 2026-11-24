/* SVG → 3D – farbige Vektorgrafik als 3MF für den Mehrfarbdruck.
 *
 * Der Browser schickt die SVG mit den Einstellungen an den Server
 * (POST api/svg3d). Dort wird jede Füllfarbe zu einem eigenen Teil extrudiert;
 * zurück kommt ein Vorschau-Netz (three.js) oder die fertige 3MF.
 */
(() => {
"use strict";
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const W = () => window.Werkstatt;
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const de = (v, d = 1) => Number(v).toFixed(d).replace(".", ",");

let file = null;            // { blob, name, url }
let colors = [];            // letzte Farbliste vom Server
let cfg = {};               // je Farbe: { include, height, filament, color }
let natural = null, hasBg = false, ok = false;

/* ------------------------------------------------------------ Datei */
async function useFile(f) {
  const err = $("#sError"); err.hidden = true;
  const isSvg = /\.svg$/i.test(f.name || "") || f.type === "image/svg+xml";
  if (!isSvg) { err.textContent = `${f.name} ist keine SVG-Datei. Andere Bilder zuerst unter „Vektorisieren“ in eine SVG umwandeln.`; err.hidden = false; return; }
  if (file) URL.revokeObjectURL(file.url);
  file = { blob: f, name: (f.name || "grafik.svg").replace(/\.[^.]+$/, ""), url: URL.createObjectURL(f) };
  $("#sThumb").innerHTML = `<li><img alt="${esc(file.name)}" src="${file.url}" style="object-fit:contain;background:#fff"><div class="ctl"><span></span><button type="button" aria-label="Entfernen">✕</button><span></span></div></li>`;
  $("#sThumb button").onclick = clearFile;
  $("#s1").classList.add("done");
  $("#sFileName").value = file.name || "modell";
  colors = []; cfg = {}; natural = null; hasBg = false;
  await activate();
  run();
}
function clearFile() {
  if (file) URL.revokeObjectURL(file.url);
  file = null; ok = false; colors = []; cfg = {};
  $("#sThumb").innerHTML = ""; $("#s1").classList.remove("done");
  $("#sWrap").hidden = true; $("#sEmpty").hidden = false; $("#sResult").hidden = true; $("#sBox").classList.remove("lit");
  $("#sColors").innerHTML = ""; $("#sColorsStep").hidden = true;
}

/* ------------------------------------------------------------ Einstellungen */
const num = (id, d) => { const x = parseFloat($("#" + id).value); return isFinite(x) ? x : d; };
const radio = (name) => (document.querySelector(`input[name=${name}]:checked`) || {}).value;
function options(format, thumbnail) {
  const c = {};
  for (const [k, v] of Object.entries(cfg)) c[k] = { include: v.include, height: v.height || null, filament: v.filament, color: v.color };
  return {
    width: Math.max(5, num("sWidth", 100)), thickness: Math.max(0.2, num("sThick", 10)),
    drop_background: $("#sDropBg").checked,
    mono: $("#sMono").checked, mono_filament: $("#sMonoName").value.trim() || "Filament", mono_color: $("#sMonoColor").value.toUpperCase(),
    colors: c,
    base: { mode: radio("sBase") || "none", thick: Math.max(0.4, num("sBaseThick", 2)), margin: Math.max(0, num("sBaseMargin", 3)),
            filament: $("#sBaseName").value.trim() || "Grundplatte", color: $("#sBaseColor").value.toUpperCase() },
    format, title: $("#sFileName").value.trim() || "modell", thumbnail: thumbnail || null,
  };
}
function hints() {
  const mono = $("#sMono").checked;
  $("#sMonoRow").hidden = !mono;
  $("#sColors").classList.toggle("off", mono);
  $("#sBaseRow").hidden = (radio("sBase") || "none") === "none";
  $("#sMarginL").hidden = false;
  $("#sBgRow").hidden = !hasBg;
  $("#sNatural").hidden = !natural;
  if (natural) $("#sNatural").textContent = `Originalgröße übernehmen (${de(natural)} mm)`;
}

/* Farbtabelle: einmal je Datei aufbauen, danach nur Anteile aktualisieren */
function buildColorTable(list) {
  for (const c of list) if (!cfg[c.hex]) cfg[c.hex] = { include: true, height: null, filament: c.name, color: c.hex };
  $("#sColors").innerHTML = list.map(c => {
    const v = cfg[c.hex];
    return `<li data-k="${c.hex}" class="${v.include ? "" : "off"}">
      <label class="check sinc"><input type="checkbox" data-f="include" ${v.include ? "checked" : ""} aria-label="${c.hex} verwenden"></label>
      <input type="color" data-f="color" value="${v.color}" aria-label="Filamentfarbe für ${c.hex}">
      <input type="text" data-f="filament" value="${esc(v.filament)}" maxlength="30" aria-label="Filament für ${c.hex}">
      <input type="number" data-f="height" value="${v.height ?? ""}" placeholder="${de(num("sThick", 10))}" min="0.2" max="100" step="0.2" aria-label="Höhe in mm für ${c.hex}">
      <span class="vpc" data-share>${de(c.share)} %</span></li>`;
  }).join("");
  $("#sColorsStep").hidden = false;
}
function updateShares(list) {
  for (const c of list) {
    const li = $(`#sColors li[data-k="${c.hex}"]`);
    if (!li) return buildColorTable(list);
    li.querySelector("[data-share]").textContent = c.used ? `${de(c.share)} %` : "–";
  }
  $$("#sColors input[data-f=height]").forEach(i => i.placeholder = de(num("sThick", 10)));
}

/* ------------------------------------------------------------ Anfrage */
async function request(format, thumbnail) {
  const fd = new FormData();
  fd.append("file", file.blob, (file.name || "grafik") + ".svg");
  fd.append("options", JSON.stringify(options(format, thumbnail)));
  const r = await fetch("api/svg3d", { method: "POST", body: fd });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(typeof j.detail === "string" ? j.detail : Array.isArray(j.detail) ? "Eingabe ungültig: " + (j.detail[0]?.msg || "") : "Der Server konnte das Modell nicht berechnen.");
  }
  return format === "mesh" ? r.json() : r.blob();
}

/* ------------------------------------------------------------ Vorschau */
let renderer, scene, camera, persp, ortho, controls, group, view = "iso", elView;
function initView() {
  const el = $("#sView");
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  el.appendChild(renderer.domElement);
  elView = el;
  scene = new THREE.Scene();
  persp = new THREE.PerspectiveCamera(30, 1, 1, 20000); persp.up.set(0, 0, 1);
  ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 20000); ortho.up.set(0, 1, 0);
  camera = persp;
  controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445066, 0.8));
  const d1 = new THREE.DirectionalLight(0xffffff, 0.7); d1.position.set(-1, -2, 3); scene.add(d1);
  const d2 = new THREE.DirectionalLight(0xffe2b0, 0.35); d2.position.set(2, 1, 1.5); scene.add(d2);
  group = new THREE.Group(); scene.add(group);
  const resize = () => { const w = el.clientWidth, h = el.clientHeight; if (!w || !h) return; renderer.setSize(w, h); persp.aspect = w / h; persp.updateProjectionMatrix(); if (group.children.length) setView(view); };
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
  $$("[data-sview]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.sview === v)));
  const box = new THREE.Box3().setFromObject(group);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  const aspect = Math.max(0.2, (elView.clientWidth || 1) / (elView.clientHeight || 1));
  const R = size.length() / 2;
  if (v === "top") {
    const half = Math.max(size.x / aspect, size.y) / 2 * 1.12;
    ortho.left = -half * aspect; ortho.right = half * aspect; ortho.top = half; ortho.bottom = -half;
    ortho.near = 0.1; ortho.far = R * 10 + size.z * 10; ortho.zoom = 1;
    camera = ortho; camera.position.set(c.x, c.y, c.z + R * 3); ortho.updateProjectionMatrix();
  } else {
    camera = persp;
    const D = R / Math.sin(THREE.MathUtils.degToRad(persp.fov / 2)) * 0.9;
    camera.position.set(c.x + D * 0.35, c.y - D * 0.75, c.z + D * 0.6);
    persp.near = Math.max(0.5, D / 200); persp.far = D * 50; persp.updateProjectionMatrix();
  }
  controls.object = camera; controls.target.copy(c); controls.update();
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
let busy = false, pending = false, timer = null;
async function run() {
  if (!file || !renderer) return;
  if (busy) { pending = true; return; }
  busy = true; pending = false;
  const err = $("#sError"), st = $("#sStatus");
  err.hidden = true; st.textContent = "Berechne …";
  const t0 = performance.now();
  try {
    const res = await request("mesh");
    const first = !colors.length;
    colors = res.colors; natural = res.natural_mm; hasBg = res.background;
    if (first) buildColorTable(colors); else updateShares(colors);
    hints();
    $("#sEmpty").hidden = true; $("#sWrap").hidden = false; $("#sBox").classList.add("lit");
    window.dispatchEvent(new Event("resize"));
    showParts(res.parts);
    $("#sWarn").innerHTML = res.warnings.map(w => `<li>${esc(w)}</li>`).join("");
    $("#sWarnBox").hidden = !res.warnings.length;
    $("#sStats").innerHTML = [["Größe", `${de(res.size[0])} × ${de(res.size[1])} × ${de(res.size[2])} mm`], ["Teile", res.parts.length]]
      .map(([k, v]) => `<span>${k} <b>${v}</b></span>`).join("");
    const keys = [];
    $("#sLegend").innerHTML = res.parts.map(p => {
      const k = p.filament + "|" + p.color; if (!keys.includes(k)) keys.push(k);
      return `<li><span class="sw" style="background:${p.color}"></span><span>Filament ${keys.indexOf(k) + 1}: ${esc(p.filament)}</span><span class="pc">${esc(p.name)}</span></li>`;
    }).join("");
    $("#sResult").hidden = false;
    ok = true;
    st.textContent = `Vorschau aktualisiert in ${Math.round(performance.now() - t0)} ms`;
  } catch (e) {
    ok = false;
    err.textContent = e.message === "Failed to fetch" ? "Der Server ist nicht erreichbar." : e.message; err.hidden = false; st.textContent = "";
  } finally { busy = false; if (pending) run(); }
}
const schedule = () => { clearTimeout(timer); timer = setTimeout(run, 400); };

async function download() {
  const err = $("#sError");
  if (!file) { err.textContent = "Lade zuerst eine SVG-Datei."; err.hidden = false; return; }
  if (!ok) return;
  const go = $("#sGo"); go.disabled = true; go.textContent = "3MF wird gepackt …"; err.hidden = true;
  try {
    const blob = await request("3mf", thumbnail());
    const name = ($("#sFileName").value.trim() || "modell").replace(/[\\/:*?"<>|]+/g, "_") + ".3mf";
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    $("#s5").classList.add("done");
  } catch (e) { err.textContent = e.message; err.hidden = false; }
  finally { go.disabled = false; go.textContent = "3MF herunterladen"; }
}

/* ------------------------------------------------------------ Start */
let started = null;
function activate() {
  if (started) return started;
  started = (async () => {
    if (!window.Werkstatt) await new Promise(r => { const t = setInterval(() => { if (window.Werkstatt) { clearInterval(t); r(); } }, 100); });
    try {
      if (!window.THREE) await W().loadScript(W().THREE_URL);
      if (!THREE.OrbitControls) await W().loadScript(W().ORBIT_URL);
    } catch (e) {
      $("#sError").textContent = "Die 3D-Vorschau braucht eine Internetverbindung (three.js vom CDN)."; $("#sError").hidden = false;
      started = null; return;
    }
    initView();
    $("#sFile").addEventListener("change", (e) => { if (e.target.files[0]) useFile(e.target.files[0]); e.target.value = ""; });
    const drop = $("#sDrop");
    ["dragenter", "dragover"].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add("over"); }));
    ["dragleave", "drop"].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove("over"); }));
    drop.addEventListener("drop", e => { const f = e.dataTransfer.files[0]; if (f) useFile(f); });
    $$("#sForm input, #sForm select").forEach(el => {
      if (el.id === "sFile" || el.id === "sFileName" || el.closest("#sColors")) return;
      el.addEventListener(el.type === "number" || el.type === "text" ? "input" : "change", () => { hints(); schedule(); });
    });
    $("#sThick").addEventListener("input", () => $$("#sColors input[data-f=height]").forEach(i => i.placeholder = de(num("sThick", 10))));
    $("#sNatural").addEventListener("click", () => { if (natural) { $("#sWidth").value = natural; schedule(); } });
    const onColor = (e) => {
      const li = e.target.closest("li[data-k]"); if (!li) return;
      const v = cfg[li.dataset.k], f = e.target.dataset.f;
      if (f === "include") { v.include = e.target.checked; li.classList.toggle("off", !v.include); }
      else if (f === "height") { const x = parseFloat(e.target.value); v.height = isFinite(x) && x > 0 ? x : null; }
      else if (f === "color") v.color = e.target.value.toUpperCase();
      else if (f === "filament") v.filament = e.target.value.trim();
      schedule();
    };
    $("#sColors").addEventListener("input", onColor);
    $("#sColors").addEventListener("change", onColor);
    $$("[data-sview]").forEach(b => b.addEventListener("click", () => setView(b.dataset.sview)));
    $("#sForm").addEventListener("submit", (e) => { e.preventDefault(); download(); });
    hints();
  })();
  return started;
}
window.Svg3d = { activate, useFile };
if (!$("#modeSvg").hidden) activate();
})();

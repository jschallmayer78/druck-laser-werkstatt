/* Vektorisieren – beliebige Grafik in ein SVG umwandeln.
 *
 * Der Browser verkleinert große Bilder (SVGs werden gerastert) und schickt sie
 * an den Server (POST api/vectorize), der mit vtracer nachzeichnet. Umfärben,
 * Ausblenden, Ansichten und Downloads passieren hier im Browser.
 */
(() => {
"use strict";
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const de = (v, d = 1) => Number(v).toFixed(d).replace(".", ",");

const PRESETS = {
  logo:  { mode: "color",  colors: "0",  detail: 6, speckle: 4,  curves: "spline", layers: "stacked", bg: "edge", invert: false },
  illu:  { mode: "color",  colors: "8",  detail: 7, speckle: 4,  curves: "spline", layers: "stacked", bg: "none", invert: false },
  line:  { mode: "binary", colors: "0",  detail: 8, speckle: 2,  curves: "spline", layers: "stacked", bg: "none", invert: false },
  cut:   { mode: "binary", colors: "0",  detail: 6, speckle: 10, curves: "spline", layers: "cutout",  bg: "edge", invert: false },
  photo: { mode: "color",  colors: "12", detail: 5, speckle: 8,  curves: "spline", layers: "stacked", bg: "none", invert: false },
};

let src = null;          // { blob, name, url, w, h }
let result = null;       // Antwort des Servers
let doc = null;          // geparstes SVG
let keyOf = new Map();   // Füllfarbe im SVG -> Palettenfarbe
let recolor = {}, hidden = new Set();
let view = "side", backdrop = "check", aiOk = true;
let timer = null, rtimer = null, ctrl = null;

/* ------------------------------------------------------------ Bild laden */
async function prepare(file) {
  if (window.isSvg && window.isSvg(file)) file = await window.svgToPng(file, 2400);
  if (!file.type.startsWith("image/")) throw new Error(`${file.name} ist kein Bild.`);
  const url = URL.createObjectURL(file);
  const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error(`${file.name} lässt sich nicht öffnen.`)); i.src = url; });
  let blob = file, w = im.naturalWidth, h = im.naturalHeight;
  const max = 2400;
  if (Math.max(w, h) > max) {
    const k = max / Math.max(w, h), c = document.createElement("canvas");
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
    const jpeg = /jpe?g/i.test(file.type);
    blob = await new Promise(r => c.toBlob(r, jpeg ? "image/jpeg" : "image/png", 0.92));
    w = c.width; h = c.height;
  }
  URL.revokeObjectURL(url);
  return { blob, name: file.name.replace(/\.[^.]+$/, ""), url: URL.createObjectURL(blob), w, h };
}
async function setFile(file) {
  const err = $("#vError"); err.hidden = true;
  try {
    if (src) URL.revokeObjectURL(src.url);
    src = await prepare(file);
    $("#vThumb").innerHTML = `<li><img alt="${esc(src.name)}" src="${src.url}"><div class="ctl"><span></span><button type="button" aria-label="Entfernen">✕</button><span></span></div></li>`;
    $("#vThumb button").onclick = clearFile;
    $("#v1").classList.add("done");
    $("#vName").value = src.name || "grafik";
    recolor = {}; hidden = new Set();
    run();
  } catch (e) { err.textContent = e.message; err.hidden = false; }
}
function clearFile() {
  if (src) URL.revokeObjectURL(src.url);
  src = null; result = null; doc = null;
  $("#vThumb").innerHTML = ""; $("#v1").classList.remove("done");
  $("#vWrap").hidden = true; $("#vEmpty").hidden = false; $("#vResult").hidden = true; $("#vBox").classList.remove("lit");
}

/* ------------------------------------------------------------ Einstellungen */
const radio = (name) => (document.querySelector(`input[name=${name}]:checked`) || {}).value;
function options() {
  return {
    mode: radio("vMode"), colors: +$("#vColors").value,
    threshold: $("#vThreshAuto").checked ? null : +$("#vThresh").value,
    detail: +$("#vDetail").value, speckle: +$("#vSpeckle").value,
    curves: $("#vCurves").value, layers: $("#vLayers").value,
    background: radio("vBg"), tolerance: +$("#vTol").value, bg_inside: $("#vInside").checked,
    invert: $("#vInvert").checked,
  };
}
function applyPreset(p) {
  const P = PRESETS[p]; if (!P) return;
  document.querySelector(`input[name=vMode][value=${P.mode}]`).checked = true;
  $("#vColors").value = P.colors; $("#vDetail").value = P.detail; $("#vSpeckle").value = P.speckle;
  $("#vCurves").value = P.curves; $("#vLayers").value = P.layers;
  const bg = P.bg === "ai" && !aiOk ? "edge" : P.bg;
  document.querySelector(`input[name=vBg][value=${bg}]`).checked = true;
  $("#vInvert").checked = P.invert; $("#vThreshAuto").checked = true;
  recolor = {}; hidden = new Set();
  hints();
}
function hints() {
  const bin = radio("vMode") === "binary";
  $("#vColorsRow").hidden = bin; $("#vThreshRow").hidden = !bin; $("#vLayersL").hidden = bin;
  $("#vThresh").disabled = $("#vThreshAuto").checked;
  $("#vEdgeRow").hidden = radio("vBg") !== "edge";
  $("#vDetailOut").textContent = $("#vDetail").value;
  $("#vSpeckleOut").textContent = $("#vSpeckle").value + " px";
  $("#vTolOut").textContent = $("#vTol").value;
  $("#vThreshOut").textContent = $("#vThreshAuto").checked ? (result && result.threshold ? `automatisch (${result.threshold})` : "automatisch") : $("#vThresh").value;
}

/* ------------------------------------------------------------ Nachzeichnen */
async function run() {
  if (!src) return;
  if (ctrl) ctrl.abort();
  ctrl = new AbortController();
  const err = $("#vError"), st = $("#vStatus");
  err.hidden = true; st.textContent = "Zeichne nach …";
  const t0 = performance.now();
  const fd = new FormData();
  fd.append("file", src.blob, (src.name || "bild") + (src.blob.type === "image/jpeg" ? ".jpg" : ".png"));
  fd.append("options", JSON.stringify(options()));
  try {
    const r = await fetch("api/vectorize", { method: "POST", body: fd, signal: ctrl.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(typeof j.detail === "string" ? j.detail : "Die Grafik konnte nicht nachgezeichnet werden.");
    result = j;
    doc = new DOMParser().parseFromString(j.svg, "image/svg+xml");
    mapColors();
    // Umfärbungen von Farben behalten, die es noch gibt
    const pal = new Set(j.colors.map(c => c.hex));
    for (const k of Object.keys(recolor)) if (!pal.has(k)) delete recolor[k];
    for (const k of [...hidden]) if (!pal.has(k)) hidden.delete(k);
    $("#vEmpty").hidden = true; $("#vWrap").hidden = false; $("#vBox").classList.add("lit"); $("#vResult").hidden = false;
    render();
    hints();
    st.textContent = `Fertig in ${Math.round(performance.now() - t0)} ms` + (j.scale > 1.01 ? ` · kleines Bild vor dem Nachzeichnen ${de(j.scale)}× vergrößert` : "");
    $("#v5").classList.add("done");
  } catch (e) {
    if (e.name === "AbortError") return;
    err.textContent = e.message === "Failed to fetch" ? "Der Server ist nicht erreichbar." : e.message; err.hidden = false; st.textContent = "";
  }
}
const schedule = () => { clearTimeout(timer); timer = setTimeout(run, 450); };

function hexRgb(h) { return [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)); }
function mapColors() {
  keyOf = new Map();
  const pal = result.colors.map(c => ({ hex: c.hex, rgb: hexRgb(c.hex) }));
  for (const p of doc.querySelectorAll("path")) {
    const f = (p.getAttribute("fill") || "#000000").toUpperCase();
    if (keyOf.has(f) || !/^#[0-9A-F]{6}$/.test(f)) continue;
    const c = hexRgb(f);
    let best = pal[0], bd = Infinity;
    for (const q of pal) { const d = (q.rgb[0] - c[0]) ** 2 + (q.rgb[1] - c[1]) ** 2 + (q.rgb[2] - c[2]) ** 2; if (d < bd) { bd = d; best = q; } }
    keyOf.set(f, best ? best.hex : f);
  }
}

/* SVG mit Umfärbungen; outline: nur Umrisse */
function finalSvg(outline = false) {
  const d = doc.cloneNode(true);
  for (const p of [...d.querySelectorAll("path")]) {
    const f = (p.getAttribute("fill") || "#000000").toUpperCase(), k = keyOf.get(f) || f;
    if (hidden.has(k)) { p.remove(); continue; }
    const col = recolor[k] || k;   // auf die Palettenfarbe vereinheitlichen (vtracer weicht teils um ±1 ab)
    if (outline) { p.setAttribute("fill", "none"); p.setAttribute("stroke", col === "#FFFFFF" ? "#888888" : col); p.setAttribute("stroke-width", "1"); p.setAttribute("vector-effect", "non-scaling-stroke"); }
    else p.setAttribute("fill", col);
  }
  return new XMLSerializer().serializeToString(d);
}
let svgUrl = null;
function render(swatches = true) {
  if (!doc) return;
  if (svgUrl) URL.revokeObjectURL(svgUrl);
  svgUrl = URL.createObjectURL(new Blob([finalSvg(view === "outline")], { type: "image/svg+xml" }));
  $$(".vsvg").forEach(im => im.src = svgUrl);
  $$(".vorig").forEach(im => im.src = src.url);
  const stage = $("#vStage");
  stage.dataset.view = view; stage.dataset.bd = backdrop;
  $$("[data-vview]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.vview === view)));
  // Farbfelder (nicht neu aufbauen, solange der Farbwähler offen ist)
  if (swatches) $("#vSwatches").innerHTML = result.colors.map(c => {
    const col = recolor[c.hex] || c.hex, off = hidden.has(c.hex);
    return `<li class="${off ? "off" : ""}"><input type="color" value="${col}" data-k="${c.hex}" aria-label="Farbe ${c.hex} ändern">
      <span class="vhex">${col}${col !== c.hex ? ` <small>(war ${c.hex})</small>` : ""}</span><span class="vpc">${de(c.share)} %</span>
      <button type="button" class="btn2 vhide" data-k="${c.hex}" aria-pressed="${off}">${off ? "Einblenden" : "Ausblenden"}</button></li>`;
  }).join("");
  const svg = finalSvg();
  const nodes = (svg.match(/[MCLZ]/g) || []).length;
  $("#vStats").innerHTML = [["Farben", result.colors.filter(c => !hidden.has(c.hex)).length], ["Pfade", (svg.match(/<path/g) || []).length],
    ["Knoten", nodes.toLocaleString("de-DE")], ["Größe", `${de(svg.length / 1024)} KB`], ["Zeichenfläche", `${result.width} × ${result.height} px`]]
    .map(([k, v]) => `<span>${k} <b>${v}</b></span>`).join("");
  if (result.background) $("#vBgHint").textContent = `Entfernte Randfarbe: ${result.background}`;
  else $("#vBgHint").textContent = "";
}

/* ------------------------------------------------------------ Ausgabe */
const baseName = () => ($("#vName").value.trim() || "grafik").replace(/[\\/:*?"<>|]+/g, "_");
function save(blob, name) {
  const url = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
const svgFile = () => new File([finalSvg()], baseName() + ".svg", { type: "image/svg+xml" });
async function pngFile(scale = 2) {
  const url = URL.createObjectURL(new Blob([finalSvg()], { type: "image/svg+xml" }));
  try {
    const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const c = document.createElement("canvas"); c.width = result.width * scale; c.height = result.height * scale;
    c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, "image/png"));
    return new File([blob], baseName() + ".png", { type: "image/png" });
  } finally { URL.revokeObjectURL(url); }
}
function needResult() { if (!result) { const e = $("#vError"); e.textContent = "Lade zuerst eine Grafik."; e.hidden = false; return false; } return true; }

/* ------------------------------------------------------------ Start */
let started = false;
function activate() {
  if (started) return;
  started = true;
  fetch("api/vectorize/info").then(r => r.json()).then(j => {
    aiOk = !!j.ai;
    if (!aiOk) {
      const r = document.querySelector("input[name=vBg][value=ai]"); r.disabled = true;
      r.closest("label").title = j.ai_reason || "Nicht verfügbar";
      $("#vAiHint").textContent = "KI-Freistellung ist auf diesem Server nicht installiert; „Randfarbe entfernen“ funktioniert trotzdem.";
      $("#vAiHint").hidden = false;
    }
  }).catch(() => {});
  $("#vFile").addEventListener("change", (e) => { if (e.target.files[0]) setFile(e.target.files[0]); e.target.value = ""; });
  const drop = $("#vDrop");
  ["dragenter", "dragover"].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", e => { const f = e.dataTransfer.files[0]; if (f) setFile(f); });
  document.addEventListener("paste", (e) => {
    if ($("#modeVec").hidden) return;
    const f = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith("image/"));
    if (f) { e.preventDefault(); setFile(f); }
  });
  $$("input[name=vPreset]").forEach(r => r.addEventListener("change", () => { applyPreset(r.value); schedule(); }));
  $$("#vForm input, #vForm select").forEach(el => {
    if (["vFile", "vName", "vLayerSel"].includes(el.id) || el.name === "vPreset") return;
    el.addEventListener(el.type === "range" ? "input" : "change", () => { hints(); schedule(); });
  });
  $$("[data-vview]").forEach(b => b.addEventListener("click", () => { view = b.dataset.vview; render(); }));
  $("#vBackdrop").addEventListener("click", () => {
    backdrop = { check: "light", light: "dark", dark: "check" }[backdrop];
    $("#vBackdrop").textContent = "Hintergrund: " + { check: "Karo", light: "Hell", dark: "Dunkel" }[backdrop];
    render();
  });
  $("#vSplit").addEventListener("input", (e) => $("#vStage").style.setProperty("--split", e.target.value + "%"));
  $("#vSwatches").addEventListener("input", (e) => {
    const k = e.target.dataset.k; if (!k || e.target.type !== "color") return;
    recolor[k] = e.target.value.toUpperCase(); clearTimeout(rtimer); rtimer = setTimeout(() => render(false), 60);
  });
  $("#vSwatches").addEventListener("change", (e) => { if (e.target.type === "color") render(); });
  $("#vSwatches").addEventListener("click", (e) => {
    const b = e.target.closest(".vhide"); if (!b) return;
    const k = b.dataset.k; hidden.has(k) ? hidden.delete(k) : hidden.add(k); render();
  });
  $("#vForm").addEventListener("submit", (e) => { e.preventDefault(); if (needResult()) save(svgFile(), baseName() + ".svg"); });
  $("#vPng").addEventListener("click", async () => { if (needResult()) save(await pngFile(2), baseName() + ".png"); });
  $("#vToText").addEventListener("click", async () => {
    if (!needResult()) return;
    const k = +$("#vLayerSel").value;
    window.setMode("text");
    try { await window.Schriftzug.useSvg(k, svgFile()); }
    catch (e) { const er = $("#tError"); er.textContent = e.message; er.hidden = false; }
  });
  $("#vToLaser").addEventListener("click", async () => { if (!needResult()) return; const f = await pngFile(2); window.setMode("laser"); window.lSet(f); });
  $("#vToLitho").addEventListener("click", async () => { if (!needResult()) return; const f = await pngFile(2); window.setMode("litho"); window.addFiles([f]); });
  applyPreset("logo");
  hints();
}
window.Vektor = { activate };
if (!$("#modeVec").hidden) activate();
})();

"""SVG → 3D: farbige Vektorgrafik als Druckmodell (3MF).

Jede Füllfarbe der SVG wird ein eigenes Teil mit eigener Höhe und eigenem
Filament. Überlappungen werden wie beim Zeichnen aufgelöst: was später in der
SVG steht, liegt oben und schneidet darunterliegende Flächen aus. So liegen
die Farbteile passgenau nebeneinander, ohne sich zu durchdringen.

Ablauf:  parse() liest die SVG (Pfade, Formen, Konturen) in Flächen je Element,
         build() skaliert, löst die Überdeckungen auf und extrudiert.
"""
import hashlib
import math
import re
from collections import OrderedDict

import manifold3d as m3d
import numpy as np
import svgelements as se

MAX_POINTS = 1_500_000
MIN_AREA = 0.02          # mm²; kleinere Inseln fallen weg
NOZZLE = 0.4             # für den Hinweis auf zu feine Details

UNITS = re.compile(r'^\s*[\d.]+\s*(mm|cm|in|pt|pc)\s*$', re.I)
DPI = 96.0               # svgelements rechnet Einheiten in px zu 96 dpi um

# grobe Farbnamen als Vorschlag für den Filamentnamen
NAMES = [("Schwarz", (20, 20, 20)), ("Weiß", (250, 250, 250)), ("Grau", (128, 128, 128)),
         ("Hellgrau", (200, 200, 200)), ("Rot", (200, 30, 30)), ("Dunkelrot", (120, 20, 25)),
         ("Orange", (240, 140, 40)), ("Gelb", (245, 210, 40)), ("Beige", (225, 195, 150)),
         ("Braun", (130, 85, 50)), ("Dunkelbraun", (60, 40, 30)), ("Grün", (40, 150, 60)),
         ("Dunkelgrün", (25, 80, 40)), ("Hellgrün", (150, 210, 90)), ("Blau", (40, 90, 200)),
         ("Dunkelblau", (20, 35, 90)), ("Hellblau", (120, 180, 230)), ("Türkis", (40, 180, 180)),
         ("Lila", (120, 60, 160)), ("Rosa", (240, 150, 180)), ("Pink", (230, 60, 140)),
         ("Gold", (200, 160, 60))]


def color_name(hexcol):
    c = np.array([int(hexcol[i:i + 2], 16) for i in (1, 3, 5)], float)
    return min(NAMES, key=lambda n: np.sum((c - n[1]) ** 2))[0]


def _hex(c):
    return "#%02X%02X%02X" % (c.red, c.green, c.blue)


# ------------------------------------------------------------------ Kurven → Punkte

def _seg_points(seg, step):
    """Punkte eines Segments ohne den Startpunkt."""
    if isinstance(seg, (se.Line, se.Close)):
        return [(seg.end.x, seg.end.y)]
    if isinstance(seg, (se.CubicBezier, se.QuadraticBezier)):
        ctrl = [seg.start, seg.control1, seg.control2, seg.end] if isinstance(seg, se.CubicBezier) \
            else [seg.start, seg.control, seg.end]
        ln = sum(math.dist((a.x, a.y), (b.x, b.y)) for a, b in zip(ctrl, ctrl[1:]))
    elif isinstance(seg, se.Arc):
        ln = abs(seg.sweep) * max(abs(seg.rx), abs(seg.ry), 1e-9)
    else:
        ln = math.dist((seg.start.x, seg.start.y), (seg.end.x, seg.end.y))
    n = int(min(96, max(2, math.ceil(ln / step))))
    pts = seg.npoint(np.linspace(0, 1, n + 1)[1:])
    return [tuple(p) for p in np.asarray(pts, float)]


def _subpaths(path, step):
    """Liefert (Punkte, geschlossen) je Teilpfad."""
    out = []
    for sp in path.as_subpaths():
        pts, closed = [], False
        for seg in sp:
            if isinstance(seg, se.Move):
                if seg.end is not None:
                    pts = [(seg.end.x, seg.end.y)]
                continue
            if not pts and seg.start is not None:
                pts = [(seg.start.x, seg.start.y)]
            if isinstance(seg, se.Close):
                closed = True
            pts.extend(_seg_points(seg, step))
        # doppelte Punkte entfernen
        clean = [p for i, p in enumerate(pts) if i == 0 or math.dist(p, pts[i - 1]) > 1e-9]
        if len(clean) > 1 and closed and math.dist(clean[0], clean[-1]) < 1e-9:
            clean.pop()
        if len(clean) >= 2:
            out.append((np.array(clean, float), closed))
    return out


# ------------------------------------------------------------------ Konturen (stroke)

def _ccw(ring):
    x, y = ring[:, 0], ring[:, 1]
    return ring if np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y) >= 0 else ring[::-1]


def _circle(c, r, n=16):
    a = np.linspace(0, 2 * np.pi, n, endpoint=False)
    return np.column_stack([c[0] + r * np.cos(a), c[1] + r * np.sin(a)])


def _stroke(subpaths, width, cap="butt", join="miter", miter_limit=4.0):
    """Kontur als Fläche: Rechteck je Strecke, dazu Ecken und Enden.
    Alle Teile linksdrehend, damit NonZero sie vereinigt."""
    h = width / 2
    rings = []
    nseg = max(8, min(32, int(width * 2)))
    for pts, closed in subpaths:
        P = np.vstack([pts, pts[:1]]) if closed else pts
        d = np.diff(P, axis=0)
        ln = np.hypot(d[:, 0], d[:, 1])
        keep = ln > 1e-12
        if not keep.any():
            if cap == "round":
                rings.append(_circle(P[0], h, nseg))
            continue
        a, b, d, ln = P[:-1][keep], P[1:][keep], d[keep], ln[keep]
        u = d / ln[:, None]
        nrm = np.column_stack([-u[:, 1], u[:, 0]]) * h
        if not closed and cap == "square":
            a = a.copy(); b = b.copy()
            a[0] -= u[0] * h
            b[-1] += u[-1] * h
        for i in range(len(a)):
            rings.append(np.array([a[i] + nrm[i], a[i] - nrm[i], b[i] - nrm[i], b[i] + nrm[i]]))
        # Ecken
        idx = range(len(a)) if closed else range(1, len(a))
        for i in idx:
            j = i - 1
            v = a[i]
            cross = u[j, 0] * u[i, 1] - u[j, 1] * u[i, 0]
            if abs(cross) < 1e-9 and np.dot(u[j], u[i]) > 0:
                continue
            if join == "round":
                rings.append(_circle(v, h, nseg))
                continue
            s = -1 if cross > 0 else 1          # Außenseite
            p1, p2 = v + s * nrm[j], v + s * nrm[i]
            tri = [v, p1, p2]
            if join in ("miter", "miter-clip", "arcs"):
                cos = float(np.clip(np.dot(u[j], u[i]), -1, 1))
                half = math.acos(-cos) / 2 if cos > -1 else 0
                if half > 1e-6 and 1 / math.sin(half) <= miter_limit:
                    bis = (s * nrm[j] + s * nrm[i])
                    bn = np.linalg.norm(bis)
                    if bn > 1e-12:
                        tip = v + bis / bn * (h / math.sin(half))
                        tri = [v, p1, tip, p2]
            rings.append(np.array(tri))
        if not closed and cap == "round":
            rings.append(_circle(a[0], h, nseg))
            rings.append(_circle(b[-1], h, nseg))
    rings = [_ccw(r) for r in rings if len(r) >= 3]
    if not rings:
        return m3d.CrossSection()
    return m3d.CrossSection(rings, m3d.FillRule.NonZero)


# ------------------------------------------------------------------ Einlesen

_CACHE = OrderedDict()


def parse(raw: bytes):
    """SVG lesen. Liefert dict mit layers [(farbe, CrossSection, ist_hintergrund)],
    der natürlichen Breite in mm (falls die SVG Einheiten hat) und Hinweisen."""
    key = hashlib.sha1(raw).hexdigest()
    if key in _CACHE:
        _CACHE.move_to_end(key)
        return _CACHE[key]
    text = raw.decode("utf-8", errors="replace")
    if "<!ENTITY" in text:
        raise ValueError("Die SVG enthält Entity-Definitionen und wird aus Sicherheitsgründen nicht verarbeitet.")
    if "<svg" not in text:
        raise ValueError("Das ist keine SVG-Datei.")
    import io
    try:
        svg = se.SVG.parse(io.BytesIO(raw), reify=True)
    except Exception:
        raise ValueError("Die SVG-Datei lässt sich nicht lesen.")

    warnings = []
    shapes = []
    n_text = n_img = n_grad = n_dash = 0
    for el in svg.elements():
        if isinstance(el, se.Text):
            n_text += 1
            continue
        if isinstance(el, se.Image):
            n_img += 1
            continue
        if not isinstance(el, se.Shape):
            continue
        vals = el.values
        if vals.get("display") == "none" or vals.get("visibility") == "hidden":
            continue
        fill_raw = str(vals.get("fill", "")).strip()
        stroke_raw = str(vals.get("stroke", "")).strip()
        if fill_raw.startswith("url(") or stroke_raw.startswith("url("):
            n_grad += 1
        if vals.get("stroke-dasharray") not in (None, "", "none"):
            n_dash += 1
        shapes.append(el)

    if not shapes:
        msg = "Die SVG enthält keine Flächen oder Pfade."
        if n_text:
            msg += " Texte bitte vorher in Pfade umwandeln (Inkscape: Pfad › Objekt in Pfad)."
        raise ValueError(msg)

    # Feinheit der Kurven: relativ zur Gesamtgröße
    xs, ys = [], []
    for el in shapes:
        try:
            bb = el.bbox()
        except Exception:
            bb = None
        if bb and all(math.isfinite(v) for v in bb):
            xs += [bb[0], bb[2]]; ys += [bb[1], bb[3]]
    if not xs:
        raise ValueError("Die SVG enthält keine sichtbaren Flächen.")
    diag = math.hypot(max(xs) - min(xs), max(ys) - min(ys)) or 1.0
    step = diag / 600

    layers, total_pts = [], 0
    for el in shapes:
        path = se.Path(el)
        subs = _subpaths(path, step)
        if not subs:
            continue
        total_pts += sum(len(p) for p, _ in subs)
        if total_pts > MAX_POINTS:
            raise ValueError("Die SVG ist zu detailreich (zu viele Punkte). Bitte vorher vereinfachen.")
        fill = el.fill
        if fill is not None and fill.value is not None and fill.alpha > 0 and \
                float(el.values.get("fill-opacity", 1) or 1) > 0:
            rule = m3d.FillRule.EvenOdd if str(el.values.get("fill-rule", "")).strip() == "evenodd" \
                else m3d.FillRule.NonZero
            # offene Teilpfade werden fürs Füllen geschlossen (wie im Browser)
            rings = [p for p, _ in subs if len(p) >= 3]
            if rings:
                cs = m3d.CrossSection(rings, rule)
                if not cs.is_empty() and cs.area() > 0:
                    layers.append([_hex(fill), cs])
        sw = el.stroke_width or 0
        if el.stroke is not None and el.stroke.value is not None and el.stroke.alpha > 0 and sw > 0:
            cap = str(el.values.get("stroke-linecap", "butt")).strip() or "butt"
            join = str(el.values.get("stroke-linejoin", "miter")).strip() or "miter"
            try:
                ml = float(el.values.get("stroke-miterlimit", 4) or 4)
            except ValueError:
                ml = 4.0
            cs = _stroke(subs, sw, cap, join, ml)
            if not cs.is_empty() and cs.area() > 0:
                layers.append([_hex(el.stroke), cs])

    if not layers:
        raise ValueError("Die SVG enthält keine gefüllten Flächen oder Konturen.")

    # Hintergrund: erste Fläche, die (fast) alles abdeckt
    allb = _bounds([cs for _, cs in layers])
    full = (allb[2] - allb[0]) * (allb[3] - allb[1])
    bg = len(layers) > 1 and layers[0][1].area() >= 0.95 * full
    # Hintergrundfläche aus der Größenberechnung herausnehmen
    content = _bounds([cs for _, cs in layers[1:]]) if bg else allb

    # ähnliche Farben zusammenfassen (Nachzeichner weichen oft um ±1 ab)
    reps = []
    for L in layers:
        c = np.array([int(L[0][i:i + 2], 16) for i in (1, 3, 5)])
        for r, rc in reps:
            if np.abs(c - rc).max() <= 6:
                L[0] = r
                break
        else:
            reps.append((L[0], c))

    # natürliche Größe, wenn die SVG Einheiten hat
    natural = None
    root = re.search(r"<svg\b[^>]*>", text, re.S)
    if root:
        wm = re.search(r'\bwidth\s*=\s*["\']([^"\']+)', root.group(0))
        if wm and UNITS.match(wm.group(1)):
            natural = round((content[2] - content[0]) * 25.4 / DPI, 2)

    if n_text:
        warnings.append(f"{n_text} Text-Element(e) übersprungen – bitte in der Grafiksoftware in Pfade umwandeln.")
    if n_img:
        warnings.append(f"{n_img} eingebettete(s) Bild(er) übersprungen – nur Vektorflächen werden 3D.")
    if n_grad:
        warnings.append("Farbverläufe werden als einfarbige Fläche übernommen.")
    if n_dash:
        warnings.append("Gestrichelte Konturen werden durchgezogen.")
    if "<clipPath" in text or "<mask" in text:
        warnings.append("Beschneidungspfade und Masken werden nicht berücksichtigt.")

    res = {"layers": [tuple(L) for L in layers], "background": bg,
           "content": content, "natural_mm": natural, "warnings": warnings}
    _CACHE[key] = res
    while len(_CACHE) > 12:
        _CACHE.popitem(last=False)
    return res


def _bounds(css):
    lo, hi = [math.inf, math.inf], [-math.inf, -math.inf]
    for cs in css:
        if cs.is_empty():
            continue
        b = cs.bounds()
        lo = [min(lo[0], b[0]), min(lo[1], b[1])]
        hi = [max(hi[0], b[2]), max(hi[1], b[3])]
    if not math.isfinite(lo[0]):
        raise ValueError("Die SVG enthält keine sichtbaren Flächen.")
    return (lo[0], lo[1], hi[0], hi[1])


# ------------------------------------------------------------------ Aufbauen

def _drop_small(cs, min_area):
    parts = [p for p in cs.decompose() if p.area() >= min_area]
    lost = len(cs.decompose()) - len(parts)
    return (m3d.CrossSection.compose(parts) if parts else m3d.CrossSection()), lost


def _mesh(cs, z0, h):
    man = m3d.Manifold.extrude(cs, h).translate((0, 0, z0))
    mesh = man.to_mesh()
    return (np.asarray(mesh.vert_properties)[:, :3].astype(np.float64),
            np.asarray(mesh.tri_verts).astype(np.int64))


def build(parsed, opts):
    """opts: width, thickness, drop_background, mono, colors{hex: {include, height, filament, color}},
    base {mode, thick, margin, filament, color}.
    Liefert (parts, info) – parts: [(name, filament, farbe, verts, faces)]."""
    layers = list(parsed["layers"])
    if parsed["background"] and opts["drop_background"]:
        layers = layers[1:]
    if not layers:
        raise ValueError("Ohne Hintergrund bleibt nichts übrig.")

    cset = opts.get("colors") or {}
    def cfg(c):
        return cset.get(c) or {}

    # Überdeckung auflösen: von oben nach unten
    visible, above = OrderedDict(), m3d.CrossSection()
    for c, cs in reversed(layers):
        v = cs - above if not above.is_empty() else cs
        above = above + cs
        visible.setdefault(c, []).append(v)
    order = []
    for c, _ in layers:                          # Reihenfolge wie in der SVG
        if c not in order:
            order.append(c)
    regions = {c: m3d.CrossSection.batch_boolean(visible[c], m3d.OpType.Add) if len(visible[c]) > 1
               else visible[c][0] for c in order}

    included = [c for c in order if cfg(c).get("include", True) and not regions[c].is_empty()]
    if not included:
        raise ValueError("Alle Farben sind ausgeblendet.")

    # Maßstab: Breite der verbleibenden Flächen
    b = _bounds([regions[c] for c in included])
    w_units = b[2] - b[0]
    if w_units <= 0:
        raise ValueError("Die Grafik hat keine Breite.")
    s = opts["width"] / w_units
    mat = [[s, 0, -b[0] * s], [0, -s, b[3] * s]]     # y nach oben, Ursprung unten links

    warnings, colors_info = [], []
    total_area = sum(regions[c].area() for c in included) * s * s
    base = opts.get("base") or {"mode": "none"}
    z0 = float(base.get("thick", 0)) if base.get("mode") in ("contour", "rect") else 0.0

    parts, shapes, taken = [], [], {}
    mono = opts.get("mono")
    for c in order:
        nm = color_name(c)
        taken[nm] = taken.get(nm, 0) + 1
        if taken[nm] > 1:
            nm = f"{nm} {taken[nm]}"
        info = {"hex": c, "name": nm, "share": 0.0, "area_mm2": 0.0, "used": c in included}
        colors_info.append(info)
        if c not in included:
            continue
        cs = regions[c].transform(mat)
        cs, lost = _drop_small(cs, MIN_AREA)
        if cs.is_empty():
            info["used"] = False
            continue
        info["area_mm2"] = round(cs.area(), 1)
        info["share"] = round(100 * cs.area() / total_area, 1) if total_area else 0
        conf = cfg(c)
        h = conf.get("height") or opts["thickness"]
        fil = (conf.get("filament") or "").strip() or info["name"]
        col = conf.get("color") or c
        if mono:
            fil, col, h = opts.get("mono_filament") or "Filament", opts.get("mono_color") or c, opts["thickness"]
        shapes.append(cs)
        # Hinweis auf Stellen, die schmaler als eine Düsenbreite sind
        thin = cs.offset(-NOZZLE / 2, m3d.JoinType.Round).offset(NOZZLE / 2, m3d.JoinType.Round)
        if cs.area() > 0 and 1 - thin.area() / cs.area() > 0.12:
            warnings.append(f"„{fil}“ ({c}) hat Stellen schmaler als {str(NOZZLE).replace('.', ',')} mm – "
                            "die druckt die Düse evtl. nicht. Größer skalieren hilft.")
        parts.append([f"{fil}", fil, col.upper(), cs, h])

    if not parts:
        raise ValueError("Nach dem Skalieren ist keine druckbare Fläche übrig – bitte größer skalieren.")

    if mono:
        u = m3d.CrossSection.batch_boolean([p[3] for p in parts], m3d.OpType.Add)
        parts = [[parts[0][1], parts[0][1], parts[0][2], u, opts["thickness"]]]
        warnings = []
    else:
        # gleiche Filamente zu einem Teil zusammenfassen
        merged = OrderedDict()
        for name, fil, col, cs, h in parts:
            k = (fil, col, round(h, 3))
            if k in merged:
                merged[k][3] = merged[k][3] + cs
            else:
                merged[k] = [name, fil, col, cs, h]
        parts = list(merged.values())

    out = []
    if z0 > 0:
        allc = m3d.CrossSection.batch_boolean(shapes, m3d.OpType.Add)
        mg = max(0.0, float(base.get("margin", 0)))
        if base["mode"] == "rect":
            bb = allc.bounds()
            plate = m3d.CrossSection.square((bb[2] - bb[0] + 2 * mg, bb[3] - bb[1] + 2 * mg)) \
                .translate((bb[0] - mg, bb[1] - mg))
        else:
            plate = allc.offset(mg, m3d.JoinType.Round) if mg > 0 else allc
        v, f = _mesh(plate, 0, z0)
        bf = (base.get("filament") or "").strip() or "Grundplatte"
        out.append(("Grundplatte", bf, (base.get("color") or "#2B2B2B").upper(), v, f))
        if len(plate.decompose()) > 1:
            warnings.append("Die Grundplatte besteht aus mehreren Stücken – Rand vergrößern, damit alles zusammenhängt.")
    elif len(m3d.CrossSection.batch_boolean(shapes, m3d.OpType.Add).decompose()) > 1:
        warnings.append("Die Grafik besteht aus mehreren losen Teilen. Mit einer Grundplatte bleibt alles zusammen.")

    for name, fil, col, cs, h in parts:
        v, f = _mesh(cs, z0, h)
        out.append((name, fil, col, v, f))

    allv = np.concatenate([p[3] for p in out])
    size = (allv.max(0) - allv.min(0)).round(1).tolist()
    return out, {"colors": colors_info, "size": size, "warnings": parsed["warnings"] + warnings,
                 "background": parsed["background"], "natural_mm": parsed["natural_mm"]}

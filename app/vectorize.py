"""Vektorisieren: beliebige Grafik -> SVG (vtracer).

Ablauf: Bild auf eine sinnvolle Arbeitsgröße bringen (kleine Bilder werden
vergrößert, damit die Kanten glatt werden), optional Hintergrund entfernen
(Randfarbe oder KI-Freistellung), optional invertieren, dann
- Farbe: auf N Farben reduzieren (Median Cut, ohne Dithering) und mit
  vtracer farbig nachzeichnen,
- Schwarz-Weiß: Schwelle (automatisch nach Otsu oder fest) und schwarz
  nachzeichnen.
Durchsichtige Bereiche zeichnet vtracer nicht nach.
"""
import io
import re
import threading
from collections import OrderedDict

import numpy as np
from PIL import Image, ImageDraw, ImageOps

import vtracer

MAX_SIDE = 2400        # Arbeitsgröße: längste Seite höchstens
MIN_SIDE = 1200        # kleinere Bilder werden bis hierhin vergrößert

_mask_cache = OrderedDict()
_mask_lock = threading.Lock()


def _working_image(img):
    img = ImageOps.exif_transpose(img)
    if img.mode not in ("RGBA", "RGB"):
        img = img.convert("RGBA" if ("transparency" in img.info or img.mode in ("LA", "PA", "P")) else "RGB")
    img = img.convert("RGBA")
    w, h = img.size
    long_side = max(w, h)
    scale = 1.0
    if long_side > MAX_SIDE:
        scale = MAX_SIDE / long_side
    elif long_side < MIN_SIDE:
        scale = min(4.0, MIN_SIDE / long_side)
    if scale != 1.0:
        img = img.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
    return img, scale


def _border_color(rgb):
    """Häufigste Farbe am Bildrand (grob gerastert, dann gemittelt)."""
    a = np.asarray(rgb)
    edge = np.concatenate([a[0], a[-1], a[:, 0], a[:, -1]]).astype(np.int32)
    keys = (edge // 16) @ np.array([256, 16, 1])
    vals, counts = np.unique(keys, return_counts=True)
    best = vals[np.argmax(counts)]
    return edge[keys == best].mean(axis=0)


def _remove_edge_color(img, tolerance, inside):
    """Alles, was der Randfarbe ähnelt und mit dem Rand verbunden ist (oder
    überall, wenn inside), wird durchsichtig."""
    rgba = np.asarray(img).copy()
    rgb = rgba[..., :3].astype(np.int32)
    opaque = rgba[..., 3] > 0
    bg = _border_color(Image.fromarray(rgba[..., :3]))
    dist = np.sqrt(((rgb - bg) ** 2).sum(axis=-1))
    near = (dist <= tolerance) & opaque
    if inside:
        remove = near
    else:
        # mit dem Rand verbundene Bereiche: Flutfüllung auf der Maske
        m = Image.fromarray((near * 255).astype(np.uint8)).copy()   # beschreibbare Kopie für die Flutfüllung
        h, w = near.shape
        border = [(x, 0) for x in range(w)] + [(x, h - 1) for x in range(w)] + \
                 [(0, y) for y in range(h)] + [(w - 1, y) for y in range(h)]
        px = m.load()
        for xy in border:
            if px[xy] == 255:
                ImageDraw.floodfill(m, xy, 128)
        remove = np.asarray(m) == 128
    rgba[..., 3] = np.where(remove, 0, rgba[..., 3])
    return Image.fromarray(rgba), "#%02X%02X%02X" % tuple(int(round(c)) for c in bg)


def _ai_mask(img, raw_key, subject_mask):
    with _mask_lock:
        if raw_key in _mask_cache:
            _mask_cache.move_to_end(raw_key)
            m = _mask_cache[raw_key]
            return m if m.size == img.size else m.resize(img.size, Image.LANCZOS)
    m = subject_mask(img.convert("RGB"))
    with _mask_lock:
        _mask_cache[raw_key] = m
        while len(_mask_cache) > 6:
            _mask_cache.popitem(last=False)
    return m


def _otsu(grey, valid):
    vals = grey[valid].ravel()
    if vals.size == 0:
        return 128
    hist = np.bincount(vals, minlength=256).astype(np.float64)
    total = vals.size
    sum_all = (np.arange(256) * hist).sum()
    w0 = s0 = 0.0
    best, thr = -1.0, 128
    for t in range(256):
        w0 += hist[t]
        if w0 == 0 or w0 == total:
            continue
        s0 += t * hist[t]
        m0, m1 = s0 / w0, (sum_all - s0) / (total - w0)
        between = w0 * (total - w0) * (m0 - m1) ** 2
        if between > best:
            best, thr = between, t
    return thr + 1


def _kmeans(sample, n, rng, iters=14):
    """k-Means mit k-means++-Start. Jede Gruppe bekommt ihre häufigste echte
    Farbe (nicht den Mittelwert), damit Kantenpixel die Farben nicht verfälschen."""
    centers = [sample[rng.integers(len(sample))]]
    for _ in range(1, n):
        d = np.min(((sample[:, None, :] - np.array(centers)[None]) ** 2).sum(-1), axis=1)
        if d.sum() <= 0:
            break
        centers.append(sample[rng.choice(len(sample), p=d / d.sum())])
    C = np.array(centers, dtype=np.float32)
    for _ in range(iters):
        lab = np.argmin(((sample[:, None, :] - C[None]) ** 2).sum(-1), axis=1)
        for k in range(len(C)):
            sel = sample[lab == k]
            if len(sel):
                C[k] = sel.mean(0)
    d2 = ((sample[:, None, :] - C[None]) ** 2).sum(-1)
    lab = np.argmin(d2, axis=1)
    inertia = float(d2[np.arange(len(sample)), lab].sum())
    out, share = [], []
    for k in range(len(C)):
        sel = sample[lab == k]
        if not len(sel):
            continue
        vals, cnt = np.unique(sel.astype(np.uint8), axis=0, return_counts=True)
        out.append(vals[np.argmax(cnt)].astype(np.float32))
        share.append(len(sel) / len(sample))
    return np.array(out), np.array(share), inertia


def _best_kmeans(sample, n, tries=4):
    best = None
    for seed in range(tries):
        res = _kmeans(sample, n, np.random.default_rng(seed + 7))
        if best is None or res[2] < best[2]:
            best = res
    return best[0], best[1]


def _palette(rgb_arr, opaque, n, bg=None, tolerance=0):
    """Farbpalette mit n Farben (n = 0: automatisch bestimmen). bg: entfernte
    Hintergrundfarbe – Mischtöne daneben (Kantensaum) zählen nicht als eigene Farbe."""
    px = rgb_arr[opaque].reshape(-1, 3).astype(np.float32)
    rng = np.random.default_rng(1)
    sample = px[rng.choice(len(px), min(len(px), 40000), replace=False)] if len(px) > 40000 else px
    if not n:
        C, share = _best_kmeans(sample, 12, tries=2)
        # ähnliche Farben zusammenfassen, sehr seltene (Kantenpixel) nicht mitzählen
        order = np.argsort(-share)
        kept = []
        for i in order:
            if share[i] < 0.015:
                continue
            if bg is not None and share[i] < 0.06 and np.sqrt(((C[i] - bg) ** 2).sum()) < max(60, 2.5 * tolerance):
                continue   # Saum zwischen Motiv und entferntem Hintergrund
            if all(np.sqrt(((C[i] - C[j]) ** 2).sum()) > 45 for j in kept):
                kept.append(i)
        n = max(2, min(12, len(kept)))
    if bg is not None:
        # Saumpixel nicht als Startpunkte für die Farbsuche verwenden
        far = np.sqrt(((sample - bg) ** 2).sum(-1)) >= max(60, 2.5 * tolerance)
        if far.sum() > n * 20:
            sample = sample[far]
    C, _ = _best_kmeans(sample, n)
    return C


def _assign(rgb_arr, C):
    flat = rgb_arr.reshape(-1, 3).astype(np.float32)
    idx = np.empty(len(flat), dtype=np.int32)
    for s in range(0, len(flat), 400000):
        chunk = flat[s:s + 400000]
        idx[s:s + 400000] = np.argmin(((chunk[:, None, :] - C[None]) ** 2).sum(-1), axis=1)
    return idx.reshape(rgb_arr.shape[:2])


def vectorize(img, raw_key, o, subject_mask=None):
    """img: PIL-Bild, raw_key: Schlüssel für den Masken-Cache, o: Optionen (dict).
    Liefert dict mit svg, colors, background, width, height, scale."""
    work, scale = _working_image(img)
    bg_hex = None

    if o["background"] == "edge":
        work, bg_hex = _remove_edge_color(work, o["tolerance"], o["bg_inside"])
    elif o["background"] == "ai":
        if subject_mask is None:
            raise ValueError("Die KI-Freistellung ist auf diesem Server nicht verfügbar.")
        m = np.asarray(_ai_mask(work, raw_key, subject_mask).convert("L")) > 127
        a = np.asarray(work).copy()
        a[..., 3] = np.where(m, a[..., 3], 0)
        work = Image.fromarray(a)

    arr = np.asarray(work)
    opaque = arr[..., 3] > 127
    if not opaque.any():
        raise ValueError("Nach dem Entfernen des Hintergrunds ist nichts mehr übrig. Toleranz verringern.")
    rgb = Image.fromarray(arr[..., :3])
    if o["invert"]:
        rgb = ImageOps.invert(rgb)

    common = dict(mode=o["curves"], filter_speckle=int(o["speckle"]), path_precision=2,
                  corner_threshold=int(o["corner"]), length_threshold=float(o["length"]),
                  splice_threshold=45, max_iterations=10)

    if o["mode"] == "binary":
        grey = np.asarray(rgb.convert("L"))
        thr = _otsu(grey, opaque) if o["threshold"] is None else int(o["threshold"])
        ink = (grey < thr) & opaque
        bw = Image.fromarray(np.where(ink, 0, 255).astype(np.uint8)).convert("RGB")
        buf = io.BytesIO(); bw.save(buf, "PNG")
        svg = vtracer.convert_raw_image_to_svg(buf.getvalue(), img_format="png", colormode="binary", **common)
        colors = [{"hex": "#000000", "share": round(100.0 * ink.sum() / max(1, opaque.sum()), 1)}]
        used_threshold = int(thr)
        n = 1
    else:
        rgb_arr = np.asarray(rgb)
        bgc = None
        if bg_hex and o["background"] == "edge":
            bgc = np.array([int(bg_hex[i:i + 2], 16) for i in (1, 3, 5)], dtype=np.float32)
            if o["invert"]:
                bgc = 255 - bgc
        pal = _palette(rgb_arr, opaque, o["colors"], bgc, o["tolerance"])
        n = len(pal)
        idx = _assign(rgb_arr, pal)
        pal = pal.astype(np.uint8)
        flat = Image.fromarray(np.dstack([pal[idx].astype(np.uint8), np.where(opaque, 255, 0).astype(np.uint8)]), "RGBA")
        buf = io.BytesIO(); flat.save(buf, "PNG")
        svg = vtracer.convert_raw_image_to_svg(buf.getvalue(), img_format="png", colormode="color",
                                               hierarchical=o["layers"], color_precision=8, layer_difference=1, **common)
        counts = np.bincount(idx[opaque].ravel(), minlength=n)
        tot = max(1, counts.sum())
        colors = [{"hex": "#%02X%02X%02X" % tuple(int(c) for c in pal[i]), "share": round(100.0 * counts[i] / tot, 1)}
                  for i in np.argsort(-counts) if counts[i] > 0]
        used_threshold = None

    svg = _clean_svg(svg, work.size)
    return {
        "svg": svg, "colors": colors, "background": bg_hex, "threshold": used_threshold, "n_colors": n,
        "width": work.size[0], "height": work.size[1], "scale": round(scale, 3),
        "paths": svg.count("<path"),
    }


def _clean_svg(svg, size):
    """Kommentar entfernen, viewBox ergänzen (skalierbar), Farben vereinheitlichen."""
    w, h = size
    svg = re.sub(r"<!--.*?-->\s*", "", svg, flags=re.S)
    svg = re.sub(r'<svg\b[^>]*>',
                 f'<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">',
                 svg, count=1)
    return re.sub(r'fill="(#[0-9a-fA-F]{6})"', lambda m: f'fill="{m.group(1).upper()}"', svg)

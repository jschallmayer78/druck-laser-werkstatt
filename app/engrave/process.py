"""Bild für die Lasergravur aufbereiten.

Konvention der Ausgabedateien (wie in LightBurn & Co.): Schwarz = Laser an,
Weiß = Laser aus. Bei Materialien, die beim Gravieren hell werden (Schiefer,
schwarz eloxiertes Aluminium), wird das Bild deshalb invertiert, damit helle
Bildstellen hell auf dem Material erscheinen.
"""
import numpy as np
from PIL import Image, ImageFilter, ImageOps

from . import background

MATERIALS = {
    # invert: Gravur wird hell; base/mark: Farben für die Vorschau
    "schiefer": {"name": "Schiefer", "invert": True, "gamma": 1.0, "base": "#2B2D30", "mark": "#C9C9C4"},
    "alu": {"name": "Aluminium, schwarz eloxiert", "invert": True, "gamma": 1.0, "base": "#1E1F22", "mark": "#D8D8D8"},
    "holz": {"name": "Holz", "invert": False, "gamma": 1.0, "base": "#D9B48A", "mark": "#4A2E17"},
    "leder": {"name": "Leder", "invert": False, "gamma": 1.0, "base": "#A8743F", "mark": "#3A2210"},
}

MAX_PIXELS = 40_000_000

_BAYER8 = np.array([
    [0, 32, 8, 40, 2, 34, 10, 42],
    [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44, 4, 36, 14, 46, 6, 38],
    [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41],
    [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47, 7, 39, 13, 45, 5, 37],
    [63, 31, 55, 23, 61, 29, 53, 21],
], dtype=np.float64)


def _hex(h):
    h = h.lstrip("#")
    return np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], dtype=np.float64)


def _enhance(grey, autocontrast, detail, sharpen):
    if autocontrast:
        grey = ImageOps.autocontrast(grey, cutoff=1)
    if detail > 0:
        grey = Image.blend(grey, ImageOps.equalize(grey), detail)
    if sharpen > 0:
        grey = grey.filter(ImageFilter.UnsharpMask(radius=2, percent=int(100 * sharpen), threshold=2))
    return grey


def _rasterize(out, method, threshold):
    """Graustufen (0=Laser voll an) -> 1-Bit-Bild oder None (Graustufen behalten)."""
    if method == "none":
        return None
    if method == "floyd":
        return out.convert("1", dither=Image.FLOYDSTEINBERG)
    a = np.asarray(out, dtype=np.float64)
    if method == "ordered":
        h, w = a.shape
        tile = np.tile((_BAYER8 + 0.5) / 64 * 255, (h // 8 + 1, w // 8 + 1))[:h, :w]
        bits = a > tile
    else:  # threshold
        bits = a > threshold
    return Image.fromarray(bits.astype(np.uint8) * 255).convert("1")


def _preview(img, mat, max_w=1000):
    """Simulierte Ansicht auf dem Material."""
    g = img.convert("L")
    if g.width > max_w:
        g = g.resize((max_w, round(g.height * max_w / g.width)), Image.LANCZOS)
    burn = 1.0 - np.asarray(g, dtype=np.float64)[..., None] / 255.0
    rgb = _hex(mat["base"]) * (1 - burn) + _hex(mat["mark"]) * burn
    return Image.fromarray(rgb.clip(0, 255).astype(np.uint8))


def run(img, o):
    mat = MATERIALS[o["material"]]
    invert = mat["invert"] if o.get("invert") is None else o["invert"]
    gamma = o.get("gamma") or mat["gamma"]

    img = ImageOps.exif_transpose(img)
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        # Transparente Bereiche wie Hintergrund behandeln
        rgba = img.convert("RGBA")
        alpha = rgba.getchannel("A")
        img = Image.alpha_composite(Image.new("RGBA", rgba.size, (255, 255, 255, 255)), rgba).convert("RGB")
    else:
        alpha = None
        img = img.convert("RGB")

    mask = None
    if o["remove_bg"]:
        mask = background.subject_mask(img)
    elif alpha is not None and alpha.getextrema()[0] < 255:
        mask = alpha.point(lambda p: 255 if p > 127 else 0)

    if mask is not None and o["crop"]:
        box = mask.point(lambda p: 255 if p > 20 else 0).getbbox()
        if box:
            pad = round(0.02 * max(img.size))
            box = (max(box[0] - pad, 0), max(box[1] - pad, 0),
                   min(box[2] + pad, img.width), min(box[3] + pad, img.height))
            img, mask = img.crop(box), mask.crop(box)

    grey = _enhance(img.convert("L"), o["autocontrast"], o["detail"], o["sharpen"])
    if invert:
        grey = ImageOps.invert(grey)
    if gamma != 1.0:
        # Gamma auf die Gravurdichte: > 1 brennt Mitteltöne schwächer
        lut = [round(255 * (1 - (1 - i / 255) ** gamma)) for i in range(256)]
        grey = grey.point(lut)

    if mask is not None:
        soft = mask.filter(ImageFilter.GaussianBlur(max(1.0, mask.width / 850)))
        grey = Image.composite(grey, Image.new("L", grey.size, 255), soft)

    px_w = round(o["width_mm"] / 25.4 * o["dpi"])
    px_h = round(grey.height * px_w / grey.width)
    if px_w * px_h > MAX_PIXELS:
        raise ValueError("Breite und Auflösung ergeben ein zu großes Bild. Bitte die DPI oder die Breite verringern.")
    grey = grey.resize((px_w, px_h), Image.LANCZOS)

    raster = _rasterize(grey, o["dither"], o["threshold"])
    final = raster if raster is not None else grey
    burn = 1.0 - np.asarray(final.convert("L"), dtype=np.float64).mean() / 255.0
    height_mm = px_h / o["dpi"] * 25.4

    stats = {
        "Material": mat["name"],
        "Größe": f"{o['width_mm']:.0f} × {height_mm:.0f} mm".replace(".", ","),
        "Auflösung": f"{o['dpi']} DPI",
        "Zeilenabstand": f"{25.4 / o['dpi']:.3f} mm".replace(".", ","),
        "Pixel": f"{px_w} × {px_h}",
        "Gravierte Fläche": f"{burn * 100:.0f} %",
        "Invertiert": "ja" if invert else "nein",
    }
    return {
        "grey": grey,
        "raster": raster,
        "preview": _preview(final, mat),
        "stats": stats,
        "height_mm": round(height_mm, 1),
    }

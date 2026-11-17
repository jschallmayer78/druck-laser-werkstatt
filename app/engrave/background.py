"""Hintergrund entfernen (Freistellen) mit rembg.

rembg ist optional. Ohne das Paket steht die Funktion nicht zur Verfügung,
der Rest der Gravur-Aufbereitung funktioniert trotzdem.

Modell per Umgebungsvariable BG_MODEL wählbar (Standard: isnet-general-use).
Modelle liegen in U2NET_HOME (Standard: ~/.u2net).
"""
import os
import threading

import numpy as np
from PIL import Image

BG_MODEL = os.getenv("BG_MODEL", "isnet-general-use")
_session = None
_lock = threading.Lock()


def available():
    try:
        import rembg  # noqa: F401
        return True
    except ImportError:
        return False


def _get_session():
    global _session
    with _lock:
        if _session is None:
            from rembg import new_session
            _session = new_session(BG_MODEL)
        return _session


def subject_mask(img):
    """Maske des Motivs (0..255, gleiche Größe wie img). Löcher im Motiv
    werden gefüllt, sofern sie sich vom Hintergrund deutlich unterscheiden."""
    if not available():
        raise ValueError("Hintergrund entfernen ist auf diesem Server nicht installiert (Paket rembg fehlt).")
    from rembg import remove
    from scipy import ndimage as nd

    rgb = img.convert("RGB")
    raw = remove(rgb, session=_get_session(), only_mask=True)
    m0 = np.asarray(raw.convert("L")) > 110
    if m0.mean() < 0.005:
        raise ValueError("Im Bild wurde kein Motiv erkannt. Bitte ohne „Hintergrund entfernen“ versuchen.")

    lum = np.asarray(rgb.convert("L"), dtype=np.float64)
    # Eingeschlossene Lücken füllen. Der untere Bildrand zählt dabei nicht als
    # Hintergrund, weil Motive (Personen, Figuren) dort oft angeschnitten sind.
    padded = np.vstack([m0, np.ones((1, m0.shape[1]), bool)])
    filled = nd.binary_fill_holes(padded)[:-1]
    bg_mean = lum[~filled].mean() if (~filled).any() else lum[~m0].mean()
    added = filled & ~m0
    lab, n = nd.label(added)
    for i in range(1, n + 1):
        region = lab == i
        # Sieht die Lücke aus wie der Hintergrund, ist sie Hintergrund.
        if abs(lum[region].mean() - bg_mean) < 25:
            filled[region] = False

    filled = nd.binary_opening(filled, iterations=2)
    return Image.fromarray((filled * 255).astype(np.uint8))

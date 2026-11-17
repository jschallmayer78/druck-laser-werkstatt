"""Hintergrund entfernen (Freistellen) mit rembg.

rembg ist optional. Ohne das Paket steht die Funktion nicht zur Verfügung,
der Rest der Gravur-Aufbereitung funktioniert trotzdem.

Modell per Umgebungsvariable BG_MODEL wählbar (Standard: isnet-general-use).
Modelle liegen in U2NET_HOME (Standard: ~/.u2net).
"""
import logging
import os
import tempfile
import threading

import numpy as np
from PIL import Image

BG_MODEL = os.getenv("BG_MODEL", "isnet-general-use")
_session = None
_lock = threading.Lock()
_import_error = None
log = logging.getLogger("lithophane.engrave")



def _writable_dir(path):
    try:
        os.makedirs(path, exist_ok=True)
        probe = os.path.join(path, f".probe-{os.getpid()}")
        open(probe, "w").close()
        os.remove(probe)
        return True
    except OSError:
        return False


def _setup_numba_cache():
    """numba (über pymatting/rembg) legt beim Import einen Cache an und will
    dafür in site-packages schreiben. Im Container läuft der Dienst ohne diese
    Rechte. Deshalb einen beschreibbaren Ordner wählen, notfalls je Benutzer."""
    wanted = os.environ.get("NUMBA_CACHE_DIR")
    for path in (wanted,
                 os.path.join(tempfile.gettempdir(), "numba-cache"),
                 os.path.join(tempfile.gettempdir(), f"numba-cache-{os.getuid()}")):
        if path and _writable_dir(path):
            os.environ["NUMBA_CACHE_DIR"] = path
            return
    os.environ["NUMBA_CACHE_DIR"] = tempfile.mkdtemp(prefix="numba-cache-")


_setup_numba_cache()


def available():
    global _import_error
    try:
        import rembg  # noqa: F401
        return True
    except ImportError:
        _import_error = "Hintergrund entfernen ist auf diesem Server nicht installiert (Paket rembg fehlt)."
    except Exception as e:  # z. B. numba-Cache, onnxruntime
        log.exception("rembg konnte nicht geladen werden")
        _import_error = f"Hintergrund entfernen konnte nicht geladen werden: {e}"
    return False


def unavailable_reason():
    return _import_error


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
        raise ValueError(_import_error)
    from rembg import remove
    from scipy import ndimage as nd

    rgb = img.convert("RGB")
    try:
        raw = remove(rgb, session=_get_session(), only_mask=True)
    except Exception as e:
        log.exception("Freistellen fehlgeschlagen")
        raise ValueError(f"Hintergrund entfernen fehlgeschlagen: {e}")
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

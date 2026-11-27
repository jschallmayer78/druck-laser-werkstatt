"""Rasterverfahren für Fotos auf dem Laser.

Fehlerstreuung (Jarvis, Stucki, Atkinson, Sierra) läuft vektorisiert über
„Wellenfronten“: Pixel mit gleichem x + 3·y hängen nicht voneinander ab,
weil die Kerne höchstens 2 Spalten nach links und 2 Zeilen nach unten
streuen. So genügen etwa Breite + 3·Höhe numpy-Schritte statt einer
Python-Schleife je Pixel.

Eingabe: Graustufen 0..255 (0 = Laser voll an), Ausgabe: bool (True = weiß).
"""
import numpy as np

# (dy, dx, Gewicht) – Gewichte bezogen auf den vollen Fehler
KERNELS = {
    "jarvis": [(0, 1, 7), (0, 2, 5),
               (1, -2, 3), (1, -1, 5), (1, 0, 7), (1, 1, 5), (1, 2, 3),
               (2, -2, 1), (2, -1, 3), (2, 0, 5), (2, 1, 3), (2, 2, 1)],
    "stucki": [(0, 1, 8), (0, 2, 4),
               (1, -2, 2), (1, -1, 4), (1, 0, 8), (1, 1, 4), (1, 2, 2),
               (2, -2, 1), (2, -1, 2), (2, 0, 4), (2, 1, 2), (2, 2, 1)],
    # Atkinson streut nur 6/8 des Fehlers: kräftigere Kontraste, offene Lichter
    "atkinson": [(0, 1, 1), (0, 2, 1), (1, -1, 1), (1, 0, 1), (1, 1, 1), (2, 0, 1)],
    "sierra": [(0, 1, 5), (0, 2, 3),
               (1, -2, 2), (1, -1, 4), (1, 0, 5), (1, 1, 4), (1, 2, 2),
               (2, -1, 2), (2, 0, 3), (2, 1, 2)],
}
DIVISOR = {"jarvis": 48, "stucki": 42, "atkinson": 8, "sierra": 32}


def error_diffusion(grey, method):
    a = np.asarray(grey, dtype=np.float32)
    h, w = a.shape
    k = [(dy, dx, wt / DIVISOR[method]) for dy, dx, wt in KERNELS[method]]
    buf = np.zeros((h + 2, w + 4), np.float32)
    buf[:h, 2:w + 2] = a
    out = np.zeros((h, w), bool)
    for t in range(w + 3 * (h - 1)):
        y0 = max(0, -(-(t - w + 1) // 3))
        y1 = min(h - 1, t // 3)
        if y0 > y1:
            continue
        ys = np.arange(y0, y1 + 1)
        xs = t - 3 * ys
        old = buf[ys, xs + 2]
        on = old >= 128
        out[ys, xs] = on
        err = old - np.where(on, 255.0, 0.0)
        for dy, dx, wt in k:
            buf[ys + dy, xs + 2 + dx] += err * wt
    return out


def halftone(grey, cell_px, angle_deg=45.0):
    """Punktraster wie im Zeitungsdruck: runde Punkte auf einem 45°-Gitter.
    Die Punktfläche entspricht dem Grauwert. Bis 78 % Deckung (π/4) stehen
    die Punkte einzeln – wichtig für Glas und spröde Oberflächen."""
    a = np.asarray(grey, dtype=np.float32) / 255.0      # 1 = weiß
    h, w = a.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    th = np.deg2rad(angle_deg)
    u = (xx * np.cos(th) + yy * np.sin(th)) / cell_px
    v = (-xx * np.sin(th) + yy * np.cos(th)) / cell_px
    du, dv = u - np.floor(u) - 0.5, v - np.floor(v) - 0.5
    dist = np.sqrt(du * du + dv * dv)                  # in Zellbreiten
    dark = np.clip(1.0 - a, 0, 1)
    touch = np.pi / 4
    r = np.where(dark <= touch, np.sqrt(dark / np.pi),
                 0.5 + (dark - touch) / (1 - touch) * (np.sqrt(0.5) - 0.5))
    return ~(dist < r)

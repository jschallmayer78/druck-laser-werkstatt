"""Ambigramm: zwei Wörter, die man aus zwei Richtungen (90° versetzt) liest.

Jeder Buchstabe ist die Schnittmenge aus dem Buchstaben von Wort 1, entlang Y
extrudiert (sichtbar von vorne, Blick in +Y), und dem Buchstaben von Wort 2,
entlang X extrudiert (sichtbar von rechts, Blick in -X). Die Umrisse kommen
aus dem Browser (dort werden die Schriften gerendert), in mm, Unterkante 0,
linke Kante 0, Höhe = Buchstabenhöhe.
"""
import numpy as np
import manifold3d as m3d

FR = m3d.FillRule.EvenOdd


def _cross(rings):
    return m3d.CrossSection([np.asarray(r, dtype=np.float64).reshape(-1, 2) for r in rings], FR)


def _letter(front, side, wf, ws, cx, cy, z0):
    """Schnittkörper eines Buchstabenpaars, Mitte der Grundfläche bei (cx, cy)."""
    A, B = _cross(front), _cross(side)
    da, db = ws + 2.0, wf + 2.0
    # (u, v, w) -> (x = u, y = -w, z = v): Wort 1 von vorne lesbar
    ea = m3d.Manifold.extrude(A, da).transform(np.array(
        [[1, 0, 0, cx - wf / 2], [0, 0, -1, cy + da / 2], [0, 1, 0, z0]], dtype=np.float64))
    # (u, v, w) -> (x = w, y = u, z = v): Wort 2 von rechts lesbar
    eb = m3d.Manifold.extrude(B, db).transform(np.array(
        [[0, 0, 1, cx - db / 2], [1, 0, 0, cy - ws / 2], [0, 1, 0, z0]], dtype=np.float64))
    return ea ^ eb, A.area(), B.area()


def _mesh(man):
    m = man.to_mesh()
    return (np.asarray(m.vert_properties)[:, :3].astype(np.float64),
            np.asarray(m.tri_verts).astype(np.int64))


def build(letters, gap, base_on, base_thick, base_margin, same_color):
    """letters: Liste von dicts mit front, side (Ringe), wf, ws, a, b (Zeichen) oder
    space=True für eine Lücke. Liefert (Teile, Warnungen); Teile sind
    (Name, Punkte, Dreiecke, Rolle) mit Rolle 'letters' oder 'base'."""
    # Buchstaben tauchen 0,05 mm in den Sockel ein, damit sie sicher verschmelzen
    z0 = base_thick - 0.05 if base_on else 0.0
    solids, warnings, rects = [], [], []
    x = y = 0.0
    prev_wf = prev_ws = None
    for L in letters:
        if L.get("space"):
            x += L["wf"] + gap
            y += L["ws"] + gap
            prev_wf = prev_ws = None
            continue
        if prev_wf is not None:
            x += (prev_wf + L["wf"]) / 2 + gap
            y += (prev_ws + L["ws"]) / 2 + gap
        else:
            x += L["wf"] / 2
            y += L["ws"] / 2
        s, area_a, area_b = _letter(L["front"], L["side"], L["wf"], L["ws"], x, y, z0)
        if s.is_empty():
            warnings.append(f"„{L['a']}“ und „{L['b']}“ haben keine gemeinsame Fläche.")
        else:
            # Was sieht man wirklich? Projektion nach vorne bzw. zur Seite mit dem Original vergleichen
            front_seen = s.rotate([-90, 0, 0]).project().area()
            side_seen = s.rotate([0, 90, 0]).project().area()
            lost = []
            if area_a > 0 and front_seen < 0.97 * area_a:
                lost.append(f"von „{L['a']}“ fehlen {100 * (1 - front_seen / area_a):.0f} %")
            if area_b > 0 and side_seen < 0.97 * area_b:
                lost.append(f"von „{L['b']}“ fehlen {100 * (1 - side_seen / area_b):.0f} %")
            if lost:
                warnings.append(f"Paar „{L['a']}/{L['b']}“: " + ", ".join(lost)
                                + " – dort hat der andere Buchstabe auf gleicher Höhe nichts.")
            solids.append(s)
        rects.append((x - L["wf"] / 2, y - L["ws"] / 2, x + L["wf"] / 2, y + L["ws"] / 2))
        prev_wf, prev_ws = L["wf"], L["ws"]

    if not solids:
        raise ValueError("Aus den Wörtern ist kein Körper entstanden.")
    body = m3d.Manifold.batch_boolean(solids, m3d.OpType.Add) if len(solids) > 1 else solids[0]

    base = None
    if base_on:
        pts = np.array([[a, b] for x0, y0, x1, y1 in rects for a, b in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))], dtype=np.float64)
        hull = m3d.CrossSection.hull_points(pts)
        if base_margin > 0:
            hull = hull.offset(base_margin, m3d.JoinType.Round)
        base = m3d.Manifold.extrude(hull, base_thick)

    # schwebende Teile (z. B. Umlaut-Punkte) finden: Körper, die weder Sockel noch Druckbett berühren
    floating = [c for c in body.decompose() if c.bounding_box()[2] > z0 + 0.3]
    if floating:
        warnings.append(f"{len(floating)} Teil{'e' if len(floating) > 1 else ''} schweb{'en' if len(floating) > 1 else 't'} in der Luft "
                        "(meist Punkte von Ä, Ö, Ü oder ein i-Punkt). Mit Stützen drucken oder AE/OE/UE schreiben.")

    # mittig um den Ursprung
    parts_m = [("Buchstaben", body, "letters")]
    if base is not None:
        if same_color:
            parts_m = [("Ambigramm", body + base, "letters")]
        else:
            parts_m.append(("Sockel", base, "base"))
    lo = np.min([np.asarray(m.bounding_box()[:3]) for _, m, _ in parts_m], axis=0)
    hi = np.max([np.asarray(m.bounding_box()[3:]) for _, m, _ in parts_m], axis=0)
    shift = [-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, 0.0]
    parts = []
    for name, m, role in parts_m:
        v, f = _mesh(m.translate(shift))
        parts.append((name, v, f, role))
    return parts, warnings

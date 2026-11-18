"""Druck & Laser Werkstatt – Webservice (Lithophanes, Schriftzüge, Lasergravur).

Start lokal:  uvicorn app.main:app --host 0.0.0.0 --port 8080
"""
import base64
import hashlib
import io
import json
import os
import re
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import List, Literal, Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
import manifold3d as m3d
import numpy as np
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, Field, ValidationError, field_validator

from .engrave import background as engrave_bg
from .engrave.process import MATERIALS, run as engrave_run
from .litho.common import Obj, Part, compact
from .litho.export3mf import write_3mf
from .litho.generate import run

MAX_FILES = int(os.getenv("MAX_FILES", "6"))
MAX_FILE_MB = int(os.getenv("MAX_FILE_MB", "25"))
MAX_PARALLEL = int(os.getenv("MAX_PARALLEL", "2"))
KEEP_MINUTES = int(os.getenv("KEEP_MINUTES", "60"))
def _job_dir():
    """Ablage für fertige Dateien; fällt auf das Temp-Verzeichnis zurück,
    wenn JOB_DIR nicht beschreibbar ist."""
    for base in (os.getenv("JOB_DIR"), tempfile.gettempdir()):
        if not base:
            continue
        d = Path(base) / "werkstatt-jobs"
        try:
            d.mkdir(parents=True, exist_ok=True)
            (d / ".probe").touch()
            return d
        except OSError:
            continue
    raise RuntimeError("Kein beschreibbares Verzeichnis für die Ausgabedateien gefunden.")


JOB_DIR = _job_dir()

Image.MAX_IMAGE_PIXELS = 60_000_000
SLOTS = threading.Semaphore(MAX_PARALLEL)
STATIC = Path(__file__).parent / "static"

app = FastAPI(title="Druck & Laser Werkstatt")
app.mount("/static", StaticFiles(directory=STATIC), name="static")


class Filament(BaseModel):
    name: str = Field(min_length=1, max_length=30)
    color: str

    @field_validator("color")
    @classmethod
    def hex_color(cls, v):
        if not re.fullmatch(r"#[0-9a-fA-F]{6}", v):
            raise ValueError("Farbe muss als #RRGGBB angegeben werden")
        return v


class Options(BaseModel):
    shape: Literal["cylinder", "flat"] = "cylinder"
    color_mode: Literal["mono", "multi"] = "mono"
    flat_method: Literal["cmy", "mosaic"] = "cmy"
    palette: List[Filament] = Field(default_factory=lambda: [Filament(name="Weiß", color="#FFFFFF")])
    quality: Literal["schnell", "normal", "fein"] = "normal"
    light_d: float = Field(83.0, ge=30, le=200)
    shade_d: Optional[float] = Field(None, ge=31, le=220)
    total_d: Optional[float] = Field(None, ge=35, le=260)
    pocket_depth: float = Field(3.0, ge=0, le=20)
    floor: float = Field(4.5, ge=1.5, le=25)
    thread_clearance: float = Field(0.4, ge=0.1, le=1.0)
    height: float = Field(120.0, ge=30, le=250)
    width: float = Field(120.0, ge=30, le=250)
    enclosure: bool = True
    cable: bool = True
    border: float = Field(3.0, ge=1, le=15)
    min_t: Optional[float] = Field(None, ge=0.3, le=3)
    max_t: Optional[float] = Field(None, ge=1, le=6)
    saturation: float = Field(1.2, ge=0.5, le=2.5)
    gamma: float = Field(1.0, ge=0.4, le=2.5)
    autocontrast: bool = False
    dither: bool = False
    color_max: float = Field(0.6, ge=0.2, le=1.5)
    yellow_max: Optional[float] = Field(None, ge=0.2, le=1.5)


class EngraveOptions(BaseModel):
    material: Literal[tuple(MATERIALS)] = "schiefer"
    invert: Optional[bool] = None          # None = passend zum Material
    width_mm: float = Field(150.0, ge=10, le=1000)
    dpi: int = Field(318, ge=100, le=1000)
    remove_bg: bool = False
    crop: bool = True
    dither: Literal["floyd", "ordered", "threshold", "none"] = "floyd"
    threshold: int = Field(128, ge=1, le=254)
    autocontrast: bool = True
    detail: float = Field(0.4, ge=0, le=1)   # Anteil Histogrammausgleich
    sharpen: float = Field(1.2, ge=0, le=3)
    gamma: Optional[float] = Field(None, ge=0.4, le=2.5)  # None = passend zum Material


def _cleanup():
    limit = time.time() - KEEP_MINUTES * 60
    for pattern in ("*.3mf", "*.png"):
        for f in JOB_DIR.glob(pattern):
            if f.stat().st_mtime < limit:
                f.unlink(missing_ok=True)


def _read_image(f):
    raw = f.file.read(MAX_FILE_MB * 1024 * 1024 + 1)
    if len(raw) > MAX_FILE_MB * 1024 * 1024:
        raise HTTPException(413, f"{f.filename} ist größer als {MAX_FILE_MB} MB.")
    try:
        img = Image.open(io.BytesIO(raw))
        img.load()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
        raise HTTPException(422, f"{f.filename} ist kein lesbares Bild (JPG, PNG, WebP …).")
    return img


def _asset_version():
    h = hashlib.sha256()
    for f in sorted(STATIC.glob("*.js")):
        h.update(f.read_bytes())
    return h.hexdigest()[:10]


ASSET_VERSION = _asset_version()


@app.get("/", response_class=HTMLResponse)
def index():
    html = (STATIC / "index.html").read_text(encoding="utf-8")
    html = html.replace('src="static/schriftzug.js"', f'src="static/schriftzug.js?v={ASSET_VERSION}"')
    return HTMLResponse(html, headers={"Cache-Control": "no-cache"})


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/api/generate")
def generate(files: List[UploadFile] = File(...), options: str = Form("{}")):
    _cleanup()
    try:
        opts = Options(**json.loads(options))
    except (ValidationError, json.JSONDecodeError) as e:
        raise HTTPException(422, f"Ungültige Einstellungen: {e}")

    if not 1 <= len(files) <= MAX_FILES:
        raise HTTPException(422, f"Bitte 1 bis {MAX_FILES} Bilder hochladen.")
    if opts.color_mode == "multi" and not (opts.shape == "flat" and opts.flat_method == "cmy"):
        if not 2 <= len(opts.palette) <= 8:
            raise HTTPException(422, "Die Palette braucht 2 bis 8 Filamente.")

    images = [_read_image(f) for f in files]

    o = opts.model_dump()
    o["palette"] = [p.model_dump() for p in opts.palette]
    if o["color_mode"] == "multi" and o["palette"]:
        o["palette"][0] = {"name": o["palette"][0]["name"], "color": "#FFFFFF"}

    if not SLOTS.acquire(timeout=300):
        raise HTTPException(503, "Gerade laufen zu viele Berechnungen. Bitte in einer Minute erneut versuchen.")
    try:
        result = run(images, o)
    except ValueError as e:
        raise HTTPException(422, str(e))
    finally:
        SLOTS.release()

    job = uuid.uuid4().hex
    (JOB_DIR / f"{job}.3mf").write_bytes(result.pop("data"))
    name = "lampenschirm" if opts.shape == "cylinder" else "platte"
    name += "_farbig" if opts.color_mode == "multi" else ""
    size = (JOB_DIR / f"{job}.3mf").stat().st_size
    return {"id": job, "filename": f"{name}.3mf", "size_mb": round(size / 1e6, 1), **result}


@app.get("/api/download/{job}")
def download(job: str, name: str = "lithophane.3mf"):
    if not re.fullmatch(r"[0-9a-f]{32}", job):
        raise HTTPException(404)
    path = JOB_DIR / f"{job}.3mf"
    if not path.exists():
        raise HTTPException(404, "Die Datei ist abgelaufen. Bitte das Modell neu erzeugen.")
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", name)[:60] or "lithophane.3mf"
    return FileResponse(path, media_type="model/3mf", filename=safe)


# ---------------------------------------------------------------- Lasergravur

def _png_data_url(img):
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


@app.get("/api/engrave/info")
def engrave_info():
    return {
        "remove_bg": engrave_bg.available(),
        "remove_bg_reason": engrave_bg.unavailable_reason(),
        "materials": {k: {"name": v["name"], "invert": v["invert"], "gamma": v["gamma"]} for k, v in MATERIALS.items()},
    }


@app.post("/api/engrave")
def engrave(file: UploadFile = File(...), options: str = Form("{}")):
    _cleanup()
    try:
        opts = EngraveOptions(**json.loads(options))
    except (ValidationError, json.JSONDecodeError) as e:
        raise HTTPException(422, f"Ungültige Einstellungen: {e}")
    img = _read_image(file)

    if not SLOTS.acquire(timeout=300):
        raise HTTPException(503, "Gerade laufen zu viele Berechnungen. Bitte in einer Minute erneut versuchen.")
    try:
        result = engrave_run(img, opts.model_dump())
    except ValueError as e:
        raise HTTPException(422, str(e))
    finally:
        SLOTS.release()

    job = uuid.uuid4().hex
    dpi = (opts.dpi, opts.dpi)
    stem = re.sub(r"[^A-Za-z0-9_-]", "_", Path(file.filename or "bild").stem)[:40] or "bild"
    w = round(opts.width_mm)
    downloads = []
    if result["raster"] is not None:
        result["raster"].save(JOB_DIR / f"{job}_raster.png", dpi=dpi, optimize=True)
        downloads.append({"kind": "raster", "label": "Gerastert (direkt gravieren)",
                          "filename": f"{stem}_{opts.material}_{w}mm_{opts.dpi}dpi_raster.png"})
    result["grey"].save(JOB_DIR / f"{job}_grau.png", dpi=dpi, optimize=True)
    downloads.append({"kind": "grau", "label": "Graustufen (Raster in der Lasersoftware)",
                      "filename": f"{stem}_{opts.material}_{w}mm_{opts.dpi}dpi_grau.png"})
    for d in downloads:
        d["size_mb"] = round((JOB_DIR / f"{job}_{d['kind']}.png").stat().st_size / 1e6, 1)

    return {
        "id": job,
        "preview": _png_data_url(result["preview"]),
        "stats": result["stats"],
        "height_mm": result["height_mm"],
        "downloads": downloads,
    }


@app.get("/api/engrave/download/{job}/{kind}")
def engrave_download(job: str, kind: Literal["raster", "grau"], name: str = "gravur.png"):
    if not re.fullmatch(r"[0-9a-f]{32}", job):
        raise HTTPException(404)
    path = JOB_DIR / f"{job}_{kind}.png"
    if not path.exists():
        raise HTTPException(404, "Die Datei ist abgelaufen. Bitte neu erzeugen.")
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", name)[:90] or "gravur.png"
    return FileResponse(path, media_type="image/png", filename=safe)


# ---------------------------------------------------------------- Schriftzug
# Die Geometrie entsteht im Browser (Schriften werden dort gerendert); der
# Server packt die fertigen Netze in dieselbe 3MF wie die Lithophanes, also
# mit Filament-Zuordnung für PrusaSlicer, Orca Slicer und Bambu Studio.

MAX_TEXT_VERTS = 3_000_000
MAX_TEXT_FACES = 6_000_000


class TextPart(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    filament: str = Field("", max_length=30)
    color: str
    verts: str   # base64, float32 little endian, x y z je Punkt (mm)
    faces: str   # base64, uint32 little endian, drei Punktindizes je Dreieck
    layers: Optional[List[int]] = None  # Dreiecke je Lage; mehrere Lagen werden zu einem Körper vereinigt
    own_object: bool = False            # immer als eigenes Objekt (z. B. Einlegeteil, das flach daneben liegt)

    @field_validator("color")
    @classmethod
    def hex_color(cls, v):
        if not re.fullmatch(r"#[0-9a-fA-F]{6}", v):
            raise ValueError("Farbe muss als #RRGGBB angegeben werden")
        return v


class TextModel(BaseModel):
    title: str = Field("schriftzug", max_length=60)
    separate: bool = True                     # getrennte Objekte statt ein Objekt mit Teilen
    parts: List[TextPart] = Field(min_length=1, max_length=6)   # bis zu 4 Ebenen + Basisplatte + Ständer
    thumbnail: Optional[str] = Field(None, max_length=3_000_000)  # data:image/png;base64,...


def _decode_mesh(part):
    try:
        v = np.frombuffer(base64.b64decode(part.verts, validate=True), dtype="<f4")
        f = np.frombuffer(base64.b64decode(part.faces, validate=True), dtype="<u4")
    except ValueError:
        raise HTTPException(422, f"{part.name}: Geometrie ist nicht lesbar.")
    if v.size == 0 or v.size % 3 or f.size == 0 or f.size % 3:
        raise HTTPException(422, f"{part.name}: Geometrie ist unvollständig.")
    v = v.reshape(-1, 3).astype(np.float64)
    f = f.reshape(-1, 3).astype(np.int64)
    if len(v) > MAX_TEXT_VERTS or len(f) > MAX_TEXT_FACES:
        raise HTTPException(413, f"{part.name}: zu viele Dreiecke. Bitte eine gröbere Auflösung wählen.")
    if not np.isfinite(v).all() or f.max() >= len(v):
        raise HTTPException(422, f"{part.name}: Geometrie ist fehlerhaft.")
    return v, f


def _union_layers(v, f, layers):
    """Aufeinanderliegende Lagen (z. B. Hintergrund mit Vertiefung) zu einem
    geschlossenen Körper vereinigen. Klappt das nicht, bleiben die Lagen getrennt."""
    if not layers or len(layers) < 2 or sum(layers) != len(f) or min(layers) <= 0:
        return v, f
    try:
        man, start = None, 0
        for n in layers:
            lv, lf = compact(v, f[start:start + n])
            start += n
            m = m3d.Manifold(m3d.Mesh(vert_properties=lv.astype(np.float32), tri_verts=lf.astype(np.uint32)))
            if m.status() != m3d.Error.NoError:
                return v, f
            man = m if man is None else man + m
        if hasattr(man, "simplify"):
            # winzige Kanten an Berührstellen entfernen; sonst fallen beim Runden
            # in der 3MF Punkte zusammen und der Slicer meldet offene Kanten
            man = man.simplify(1e-3)
        mesh = man.to_mesh()
        return (np.asarray(mesh.vert_properties)[:, :3].astype(np.float64),
                np.asarray(mesh.tri_verts).astype(np.int64))
    except Exception:
        return v, f


@app.post("/api/schriftzug")
def schriftzug(model: TextModel):
    meshes = [_union_layers(*_decode_mesh(p), p.layers) for p in model.parts]
    # Teile mit gleichem Filament (Name + Farbe) teilen sich einen Filament-Platz
    slots, slot_of = [], []
    for p in model.parts:
        key = ((p.filament.strip() or p.name), p.color.upper())
        if key not in slots:
            slots.append(key)
        slot_of.append(slots.index(key) + 1)
    parts = [Part(name=p.name, slot=slot_of[i], verts=v, faces=f)
             for i, (p, (v, f)) in enumerate(zip(model.parts, meshes))]
    title = model.title.strip() or "schriftzug"
    # Slicer setzen jedes Objekt beim Laden auf die Druckplatte. Beginnt ein Teil
    # über dem Boden (aufgesetzt/eingelassen), muss alles ein Objekt bleiben.
    own = [p for p, src in zip(parts, model.parts) if src.own_object and p.verts[:, 2].min() <= 1e-3]
    rest = [p for p in parts if not any(p is o for o in own)]
    floor = min(p.verts[:, 2].min() for p in rest) if rest else 0.0
    separate = model.separate and all(p.verts[:, 2].min() <= floor + 1e-3 for p in rest)
    objects = [Obj(name=p.name, parts=[p]) for p in rest] if separate else ([Obj(name=title, parts=rest)] if rest else [])
    objects += [Obj(name=p.name, parts=[p]) for p in own]

    thumb = None
    if model.thumbnail and model.thumbnail.startswith("data:image/png;base64,"):
        try:
            thumb = base64.b64decode(model.thumbnail.split(",", 1)[1], validate=True)
        except ValueError:
            thumb = None

    if not SLOTS.acquire(timeout=300):
        raise HTTPException(503, "Gerade laufen zu viele Berechnungen. Bitte in einer Minute erneut versuchen.")
    try:
        data = write_3mf(objects, slots, thumbnail_png=thumb, arrange=False, title=title)
    finally:
        SLOTS.release()

    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", title)[:60] or "schriftzug"
    return Response(data, media_type="model/3mf",
                    headers={"Content-Disposition": f'attachment; filename="{safe}.3mf"'})

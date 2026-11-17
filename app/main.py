"""Lithophane-Werkstatt – Webservice.

Start lokal:  uvicorn app.main:app --host 0.0.0.0 --port 8080
"""
import base64
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
from fastapi.responses import FileResponse, HTMLResponse
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, Field, ValidationError, field_validator

from .engrave import background as engrave_bg
from .engrave.process import MATERIALS, run as engrave_run
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
        d = Path(base) / "lithophane-jobs"
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

app = FastAPI(title="Lithophane-Werkstatt")


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


@app.get("/", response_class=HTMLResponse)
def index():
    return (STATIC / "index.html").read_text(encoding="utf-8")


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

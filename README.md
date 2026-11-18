# Lithophane-Werkstatt

Webservice, der aus Fotos druckfertige Lithophanes erzeugt: als Lampenschirm
(Zylinder, optional mit Boden und Deckel) oder als flache Platte, einfarbig
oder mehrfarbig. Das Ergebnis ist **eine einzige 3MF-Datei**, in der jedes
Teil schon seinem Filament-Platz zugeordnet ist.

## Starten

Mit Docker (empfohlen):

    docker compose up -d --build

Danach im Browser `http://<host>:8080` öffnen.

Ohne Docker (Python 3.10 oder neuer):

    python3 -m venv .venv
    source .venv/bin/activate
    pip install -r requirements.txt
    uvicorn app.main:app --host 0.0.0.0 --port 8080

Hinter einem Reverse Proxy funktioniert die Oberfläche auch unter einem
Unterpfad (z. B. `/lithophane/`), weil sie nur relative Pfade nutzt.
Ein Upload-Limit von mindestens 150 MB im Proxy einplanen.

## Schriftzug

Über den Umschalter oben („Schriftzug“, direkt erreichbar unter
`/#schriftzug`) entsteht ein Schriftzug aus zwei Textzeilen: eine große Zeile
im Hintergrund und eine kleinere Zeile davor, jede in eigener Farbe.

- **Schriften:** rund 35 Google-Schriften (Block- und Schreibschriften),
  weitere per Name hinzufügbar oder als eigene TTF/OTF/WOFF-Datei.
- **Einstellungen je Zeile:** Text, Buchstabenhöhe in mm, Buchstabenabstand,
  Verstärkung (macht dünne Schriften druckfester); die kleine Zeile außerdem
  Versatz, Überstand und ein Rand in Hintergrundfarbe, der sie mit den großen
  Buchstaben zu einem Teil verbindet.
- **Aufbau:** *aufgesetzt* (kleine Zeile liegt oben auf), *eingelassen*
  (kleine Zeile sitzt in einer passgenauen Vertiefung, Tiefe in mm
  einstellbar) oder *durchgehend* (beide Teile ab Druckbett). Je flacher
  die Einbettung, desto später beginnen die Farbwechsel beim Druck. Wo die
  kleine Zeile über die großen Buchstaben hinausragt, reicht sie selbst bis
  aufs Druckbett oder – wenn abgewählt – nur so tief wie eingestellt (dann mit
  Stützen drucken); Hintergrundmaterial gibt es nur hinter den Buchstaben.
  Alternativ als **Einlegeteil**: Die großen Buchstaben bekommen eine
  Aussparung (Spiel einstellbar), die kleine Zeile liegt als flaches Teil
  daneben in der 3MF und kann in Bambu Studio auf eine zweite Platte gezogen
  werden. Der
  Hintergrund wird auf dem Server mit manifold3d zu einem geschlossenen
  Körper vereinigt.
- **Ergebnis:** 3MF mit zwei getrennten Objekten (oder auf Wunsch einem
  Objekt mit zwei Teilen), Filament 1 = Hintergrund, Filament 2 =
  Vordergrund, schon zugeordnet. Dazu eine SVG mit beiden Ebenen in ihren
  Farben für Laser oder Plotter.

Die Geometrie entsteht im Browser (Schriften rendern, Konturen verfolgen,
extrudieren); die 3D-Vorschau nutzt three.js vom CDN. Der Server packt die
Netze nur noch in die 3MF.

## Lasergravur

Über den Umschalter oben („Lasergravur“, direkt erreichbar unter `/#laser`)
bereitet die Werkstatt ein Foto als Gravurvorlage für Diodenlaser und
CO₂-Laser auf:

- **Material:** Schiefer und schwarz eloxiertes Aluminium (Gravur wird hell,
  das Bild wird automatisch invertiert), Holz und Leder (Gravur wird dunkel).
- **Größe und Auflösung:** Breite in mm und DPI passend zum Zeilenabstand
  der Lasersoftware (318 DPI = 0,08 mm). Die DPI stehen in der PNG-Datei,
  LightBurn übernimmt damit die Größe direkt.
- **Hintergrund entfernen:** Das Motiv wird freigestellt (rembg), nur das
  Motiv wird graviert. Löcher im Motiv, die sich klar vom Hintergrund
  unterscheiden, werden automatisch gefüllt.
- **Rasterung:** Fehlerstreuung (Floyd-Steinberg) für Fotos, gleichmäßige
  Rasterpunkte, Schwellwert für Strichbilder oder nur Graustufen, wenn die
  Lasersoftware rastern soll.
- **Ergebnis:** gerasterte 1-Bit-PNG (direkt gravieren, Modus
  „Threshold“/„Pass-Through“) und eine Graustufen-PNG, dazu eine Vorschau,
  wie es auf dem Material aussieht.

Konvention: Schwarz = Laser an, Weiß = Laser aus.

„Hintergrund entfernen“ braucht die optionalen Pakete aus
`requirements-bg.txt` und ein Modell (ca. 180 MB, Standard
`isnet-general-use`, einstellbar über `BG_MODEL`). Das Docker-Image bringt
beides mit; mit `--build-arg WITH_BG_REMOVAL=0` bleibt es klein, die Option
ist dann in der Oberfläche ausgegraut. Pro Freistellung etwa 1 GB RAM
einplanen. Ohne Docker:

    pip install -r requirements-bg.txt

## Was erzeugt wird

| Form | Farbe | Inhalt der 3MF |
|---|---|---|
| Lampenschirm | einfarbig | Relief, optional Boden + Deckel |
| Lampenschirm | mehrfarbig | weißes Relief + Farbhaut-Mosaik aus 2–8 Filamenten |
| Platte | einfarbig | ein Relief je Bild |
| Platte | Farbmischung | Weiß + Cyan/Magenta/Gelb-Schichten (4 Filamente) |
| Platte | eigene Farben | weißes Relief + Mosaik aus 2–8 Filamenten |

Filament 1 ist immer Weiß. Boden und Deckel werden ebenfalls mit Filament 1
gedruckt. Beim Lampenschirm werden sie aufgeschraubt: Der Schirm bekommt oben
und unten ein Außengewinde (3 mm Steigung, 2,5 Gänge, 45°-Flanken, stützfrei
druckbar), Boden und Deckel das passende Innengewinde. Bodenstärke, Tiefe der
Vertiefung für die Lichtquelle und das Gewindespiel sind einstellbar.

Die Größe des Lampenschirms ergibt sich standardmäßig aus der Lichtquelle
(+1 mm). Alternativ lässt sich der Außen-Ø der ganzen Lampe vorgeben (breiteste
Stelle, also Boden/Deckel bzw. ohne sie der Schirm) oder unter den
Feineinstellungen der Innen-Ø des Schirms.

## Hinweise zur 3MF-Datei

Die Datei enthält Standard-3MF mit Farben je Teil sowie die Teile- und
Filament-Zuordnung im PrusaSlicer-Projektformat (zusätzlich als
`model_settings.config` für Orca Slicer und Bambu Studio). PrusaSlicer liest
diese Zuordnung direkt. Falls ein Slicer die Filamente nicht automatisch
übernimmt, sind die Teile trotzdem getrennt und benannt („Relief weiß“,
„Farbe Rot“ …) und lassen sich in der Objektliste zuweisen.

## Einstellungen per Umgebungsvariable

| Variable | Standard | Bedeutung |
|---|---|---|
| `MAX_FILES` | 6 | Bilder pro Auftrag |
| `MAX_FILE_MB` | 25 | Größe je Bild |
| `MAX_PARALLEL` | 2 | gleichzeitige Berechnungen |
| `KEEP_MINUTES` | 60 | Aufbewahrung der fertigen Dateien |
| `JOB_DIR` | Temp-Verzeichnis | Ablage der fertigen Dateien |
| `BG_MODEL` | `isnet-general-use` | rembg-Modell fürs Freistellen (z. B. `u2netp` für wenig RAM) |

## API

`POST /api/generate` (multipart: `files` = Bilder, `options` = JSON) liefert
Vorschau, Filament-Legende und eine Job-ID; `GET /api/download/{id}` liefert
die 3MF. Die Optionen sind in `app/main.py` (Klasse `Options`) beschrieben.

Lasergravur: `POST /api/engrave` (multipart: `file` = Bild, `options` =
JSON, siehe Klasse `EngraveOptions`) liefert Vorschau, Kennzahlen und eine
Job-ID; `GET /api/engrave/download/{id}/raster` bzw. `/grau` liefert die
PNG-Dateien. `GET /api/engrave/info` meldet, ob Freistellen verfügbar ist.

Schriftzug: `POST /api/schriftzug` (JSON, siehe Klasse `TextModel`: Teile mit
Name, Filament, Farbe und den Netzen als Base64 – Punkte float32, Dreiecke
uint32) liefert direkt die 3MF-Datei.

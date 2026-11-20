# Druck & Laser Werkstatt

Webservice, der aus Fotos und Text druckfertige Vorlagen für 3D-Drucker und
Laser erzeugt. Fünf Werkzeuge, umschaltbar oben auf der Seite:

- **Lithophane (3D-Druck):** Fotos oder SVG-Grafiken als Lampenschirm (Zylinder, optional mit
  Boden und Deckel) oder flache Platte, einfarbig oder mehrfarbig.
- **Schriftzug (3D-Druck):** bis zu vier Textebenen, große Buchstaben
  hinten und kleinere Zeilen davor, jede in eigener Farbe.
- **Ambigramm (3D-Druck):** zwei Wörter in einem Objekt – von vorne liest
  man das eine, um 90° gedreht das andere.
- **Vektorisieren (Bild → SVG):** beliebige Grafik als saubere SVG, mit
  Hintergrund entfernen und Invertieren.
- **Lasergravur:** Fotos oder SVG-Grafiken als Gravurvorlage für Schiefer, Holz, Leder oder
  eloxiertes Aluminium.

3D-Druck-Ergebnisse kommen als **eine einzige 3MF-Datei**, in der jedes Teil
schon seinem Filament-Platz zugeordnet ist.

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
Unterpfad (z. B. `/werkstatt/`), weil sie nur relative Pfade nutzt.
Ein Upload-Limit von mindestens 150 MB im Proxy einplanen.

## Schriftzug

Über den Umschalter oben („Schriftzug“, direkt erreichbar unter
`/#schriftzug`) entsteht ein Schriftzug aus **1 bis 4 Ebenen**. Ebene 1 liegt
ganz hinten, jede weitere sitzt vor den Ebenen dahinter und bekommt ihr
eigenes Filament.

- **Schriften:** rund 35 Google-Schriften (Block- und Schreibschriften),
  weitere per Name hinzufügbar oder als eigene TTF/OTF/WOFF-Datei.
- **Grafik statt Text:** Jede Ebene kann statt Text eine SVG-Datei sein
  (Logo, Symbol, Wappen). Alles, was in der Grafik nicht durchsichtig ist,
  wird zur Fläche; Höhe, Versatz, Verstärkung, Rand, Aufbau, Einlegeteil,
  Basisplatte und Ständer funktionieren wie bei Text. Leere Ränder der
  Zeichenfläche werden ignoriert, Skripte in der SVG nicht ausgeführt.
- **Einstellungen je Ebene:** Text, Buchstabenhöhe in mm, Buchstabenabstand,
  Verstärkung (macht dünne Schriften druckfester), Farbe und Filamentname.
  Ebene 1 hat eine Dicke, jede weitere Ebene Versatz, Überstand über die
  Ebene davor und einen Rand in der Farbe der Ebene davor.
- **Aufbau je Ebene (ab Ebene 2):** *aufgesetzt* (liegt auf den Ebenen
  dahinter), *eingelassen* (sitzt in einer passgenauen Vertiefung, Tiefe in
  mm) oder *durchgehend* (reicht vor den Ebenen dahinter bis aufs
  Druckbett). Die Vertiefung richtet sich nach der Ebene, die an der Stelle
  zuoberst liegt. Wo nichts dahinter ist, reicht die Ebene bis aufs Druckbett
  oder – wenn abgewählt – nur so tief wie eingestellt (dann mit Stützen
  drucken). Material einer hinteren Ebene gibt es nur hinter deren
  Buchstaben und Rändern.
- **Einlegeteil:** Jede Ebene ab 2 kann als flaches Einlegeteil gedruckt
  werden. Die Ebenen dahinter bekommen eine Aussparung (Spiel einstellbar),
  das Teil liegt unter dem Schild in der 3MF und kann in Bambu Studio auf eine
  weitere Platte gezogen werden.
- **Basisplatte (optional):** Rechteck mit Eckenradius, Oval oder entlang
  der Kontur der Schrift, mit einstellbarem Rand und Dicke. Eigene Farbe
  (eigener Filament-Platz) oder in der Farbe von Ebene 1. Alle Ebenen stehen
  auf der Platte; „bis aufs Druckbett“ heißt dann „bis auf die Platte“.
- **Ständer (optional, mit Basisplatte):** Die Platte bekommt unten eine
  Steckzunge, dazu kommt ein separater Ständer mit schrägem Schlitz –
  durchgehender Sockel oder zwei kurze Füße, Neigung, Einstecktiefe, Spiel und
  Tiefe einstellbar. Beides wird liegend gedruckt und liegt flach in der 3MF.
- **Ergebnis:** 3MF mit einem Objekt je Ebene (oder auf Wunsch einem Objekt
  mit mehreren Teilen), Filamente schon zugeordnet; Teile mit gleichem Filament teilen sich einen Platz. Beginnt eine Ebene
  über dem Druckbett, wird automatisch ein Objekt mit Teilen gespeichert, damit
  der Slicer sie nicht absenkt. Dazu eine SVG mit allen Ebenen in ihren Farben
  für Laser oder Plotter.

Die Geometrie entsteht im Browser (Schriften rendern, Konturen verfolgen, das
Modell in Höhenbänder zerlegen, extrudieren); die 3D-Vorschau nutzt three.js
vom CDN. Der Server vereinigt die Bänder jeder Ebene mit manifold3d zu einem
geschlossenen Körper und packt alles in die 3MF.

## SVG-Grafiken bei Lithophane und Lasergravur

Beide Werkzeuge nehmen neben JPG, PNG und WebP auch SVG-Dateien an. Der
Browser wandelt sie vor dem Hochladen in ein PNG mit 3000 Pixeln an der
langen Seite um; Transparenz bleibt erhalten, eingebettete Skripte laufen
nicht. Bei Lithophanes werden durchsichtige Bereiche weiß (dünn, hell im
Gegenlicht), bei der Lasergravur bleiben sie ungraviert.

## Ambigramm

Unter „Ambigramm“ (`/#ambigramm`) entsteht aus zwei gleich langen Wörtern ein
Objekt, das von vorne Wort 1 und von rechts Wort 2 zeigt. Jeder Buchstabe ist
die Schnittmenge aus einem Buchstaben von Wort 1 (nach hinten extrudiert) und
dem passenden Buchstaben von Wort 2 (zur Seite extrudiert).

- Schriftart, Buchstabenhöhe und Abstand wählbar; jeder Buchstabe wird exakt
  auf dieselbe Höhe gebracht. Kräftige Blockschriften funktionieren am besten.
- Leerzeichen müssen in beiden Wörtern an derselben Stelle stehen.
- Optionaler Sockel (Dicke, Rand) in eigener Farbe oder in der Farbe der
  Buchstaben; die Buchstaben verschmelzen mit ihm zu einem Stück.
- Die Vorschau hat Knöpfe für „Wort 1“, „Wort 2“ (verzerrungsfreie
  Parallelprojektion) und eine Schrägansicht.
- Der Server meldet Buchstabenpaare, bei denen von einem Buchstaben etwas
  verloren geht (der andere hat auf gleicher Höhe nichts), und schwebende
  Teile wie Umlaut-Punkte.

Die Umrisse entstehen im Browser, die Schnittmengen berechnet der Server mit
manifold3d (`POST /api/ambigramm`, `format` = `mesh` für die Vorschau oder
`3mf`).

## Vektorisieren (Bild → SVG)

Unter „Vektorisieren“ (`/#vektor`) wird aus einem Foto, Logo oder einer
Zeichnung (JPG, PNG, WebP, GIF, BMP, SVG; auch per Einfügen aus der
Zwischenablage) eine SVG-Grafik.

- **Voreinstellungen:** Logo, Illustration, Strichzeichnung, Plotter/Laser,
  Foto – sie setzen die Regler, danach ist alles einstellbar.
- **Nachzeichnen:** Farbe (Anzahl automatisch oder 2–16) oder Schwarz-Weiß
  (Schwelle automatisch nach Otsu oder fest), Detail, Flecken entfernen,
  glatte oder eckige Kurven, Farbflächen gestapelt oder ausgeschnitten.
- **Hintergrund:** behalten, Randfarbe entfernen (Toleranz, auf Wunsch auch
  innerhalb der Grafik) oder KI-Freistellung (wenn rembg installiert ist).
- **Invertieren:** Farben umkehren bzw. bei Schwarz-Weiß Fläche und
  Hintergrund tauschen.
- **Vorschau:** nebeneinander, Vergleich mit Schieberegler, nur SVG,
  Umrisse; Hintergrund Karo/hell/dunkel.
- **Farben:** jede Farbe mit Anteil, umfärben oder ausblenden – ohne neues
  Nachzeichnen.
- **Ausgabe:** SVG, PNG in doppelter Größe, oder direkt weiter in den
  Schriftzug (als Grafik-Ebene), die Lasergravur oder das Lithophane.

Nachgezeichnet wird auf dem Server mit vtracer (`POST /api/vectorize`).
Kleine Bilder werden vorher vergrößert, damit die Kanten glatt werden; die
Farben werden per k-Means auf die häufigste echte Farbe jeder Gruppe
reduziert, damit Kantenpixel sie nicht verfälschen.

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

# StauSimulation

Jugend Forscht 2026 – Auswirkungen von Straßensperrungen auf Verkehrsfluss, Fahrzeiten und Stau.

## Idee

Ein Straßennetz wird als Graph modelliert (Kreuzungen = Knoten, Straßen = Kanten mit
Länge, Tempolimit und Fahrstreifenzahl). Für eine gegebene Verkehrsnachfrage (Fahrten
zwischen Punkten, in Fahrzeugen/Stunde) wird eine **Verkehrsumlegung** berechnet: die
Fahrzeit jeder Straße hängt über die **BPR-Funktion** (Standardverfahren der
Verkehrsplanung) davon ab, wie stark sie im Verhältnis zu ihrer Kapazität ausgelastet
ist. Über mehrere Iterationen (Method of Successive Averages) pendelt sich ein
Gleichgewicht ein.

Eine Sperrung wird simuliert, indem die entsprechende Kante aus dem Graphen entfernt
und die Umlegung erneut berechnet wird. Verglichen werden dann Gesamtbelastung des
Netzes und Fahrzeiten einzelner Routen vorher/nachher.

Details zur Methode: [backend/app/simulation.py](backend/app/simulation.py) (Python) bzw.
[frontend/js/simulation.js](frontend/js/simulation.js) (identische Logik in JavaScript,
läuft direkt im Browser).

## Zwei Modi

- **Builder** (`builder.html`) – der Hauptfokus des Projekts: eigenes Straßennetz von
  Hand auf einem leeren Canvas anlegen (keine echte Geografie, nur eine
  Zeichenfläche). Straßentyp-Presets (Autobahn/Landstraße/Bundesstraße/
  Stadtstraße/Wohnstraße) füllen Tempolimit und Fahrstreifen vor, bleiben aber
  editierbar. Straßen können über Zwischenpunkte kurvig gezogen werden (z.B. für
  Ausfahrten/Rampen), Kreuzungen können als Ampel konfiguriert werden (Umlaufzeit +
  Grünzeit). Nach einer Simulation zeigen animierte rote Punkte den simulierten
  Fahrzeugfluss auf jeder Straße (Anzahl/Tempo grob proportional zu Fluss/Fahrzeit).
- **Stadt laden** (`city.html`): reales Hauptstraßennetz einer Stadt über
  OpenStreetMap (Nominatim + Overpass API) laden. Es werden nur "Hauptstraßen"
  geladen (motorway/trunk/primary/secondary...), keine Wohnstraßen – sonst wird der
  Graph zu groß. **Bekanntes Problem:** die öffentlichen Overpass-Server sind
  häufig überlastet und antworten dann sehr langsam oder mit Timeout, besonders bei
  großen Städten – das liegt außerhalb unserer Kontrolle (mehrere Spiegel-Server
  werden der Reihe nach probiert, hilft aber nicht immer). Aktuell nicht der
  Entwicklungsfokus.

In beiden Modi: Routen/Nachfrage definieren (zwei Kreuzungen anklicken, Fahrzeuge/h
eingeben), Straßen sperren, "Simulation starten" → Vergleich vorher/nachher. Alle
Eingaben (Straßendaten, Nachfrage, Ampel) laufen über Formulare, nicht über
Browser-`prompt()`-Dialoge.

## Ohne Server nutzen (GitHub Pages)

Simulation und Stadt-Import laufen komplett im Browser (`frontend/js/simulation.js`,
`frontend/js/osm-import.js` rufen Nominatim/Overpass direkt vom Client aus auf). Der
`frontend/`-Ordner ist deshalb eine eigenständige statische Website – einfach
`frontend/index.html` öffnen, oder auf GitHub Pages deployen: der Workflow
[.github/workflows/deploy-pages.yml](.github/workflows/deploy-pages.yml) deployt bei
jedem Push auf `main` automatisch. Dafür einmalig in den Repo-Einstellungen
**Settings → Pages → Source: GitHub Actions** wählen.

## Lokal mit Backend (optional)

Es gibt zusätzlich ein Python-Backend (`backend/`) mit identischer Simulationslogik,
z.B. für spätere serverseitige Auswertung großer Netze. Das Frontend nutzt es aktuell
nicht (siehe oben) – für lokale Entwicklung reicht `frontend/index.html` direkt zu
öffnen. Zum Backend selbst:

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate        # Windows
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Dann [http://localhost:8000](http://localhost:8000) öffnen – das Backend liefert
in diesem Modus auch das Frontend mit aus.

## Bekannte Vereinfachungen (v1 / MVP)

- Straßen werden als beidseitig befahrbar angenommen (keine Einbahnstraßen).
- Verkehrsnachfrage wird manuell eingegeben, nicht aus echten Zähldaten abgeleitet.
- Kapazität pro Fahrstreifen ist ein fester Richtwert (1800 Fz/h, HCM-Standard).
- Ampeln wirken als einfacher Grünzeitanteil (g/C) auf die Kapazität der
  anliegenden Straßen (vereinfachtes HCM-Modell); keine Berücksichtigung von
  Versatzzeiten ("grüne Welle") zwischen mehreren Ampeln.
- Kurven an Straßen (Wegpunkte) sind rein zur Darstellung; die Streckenlänge für
  die Simulation wird weiterhin direkt eingegeben, nicht aus der Kurve berechnet.
- Beim Städte-Import werden Wege an gerundeten Koordinaten zu Kreuzungen
  zusammengeführt; sehr dicht beieinanderliegende, eigentlich getrennte Punkte
  könnten in seltenen Fällen fälschlich verschmelzen. Ampeln werden dort noch
  nicht automatisch aus OSM-Daten (`highway=traffic_signals`) übernommen.

Gute Ansatzpunkte für weitere Features (z.B. in eigenen Branches): Einbahnstraßen,
echte Verkehrszähldaten statt manueller Nachfrage, Export/Import von Netzwerken als
JSON, mehrere gleichzeitige Sperrungen vergleichen, Ampeln aus OSM-Daten für den
Stadt-Modus automatisch übernehmen.

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

Details zur Methode: [backend/app/simulation.py](backend/app/simulation.py)

## Zwei Modi

- **Builder** (`builder.html`): eigenes Straßennetz von Hand auf der Karte anlegen.
- **Stadt laden** (`city.html`): reales Hauptstraßennetz einer Stadt über
  OpenStreetMap (Nominatim + Overpass API) laden. Es werden nur "Hauptstraßen"
  geladen (motorway/trunk/primary/secondary...), keine Wohnstraßen – sonst wird der
  Graph zu groß.

In beiden Modi: Routen/Nachfrage definieren (zwei Kreuzungen anklicken, Fahrzeuge/h
eingeben), Straßen sperren, "Simulation starten" → Vergleich vorher/nachher.

## Setup

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate        # Windows
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Dann [http://localhost:8000](http://localhost:8000) öffnen – das Backend liefert
auch das Frontend mit aus (kein zweiter Server nötig).

## Bekannte Vereinfachungen (v1 / MVP)

- Straßen werden als beidseitig befahrbar angenommen (keine Einbahnstraßen).
- Verkehrsnachfrage wird manuell eingegeben, nicht aus echten Zähldaten abgeleitet.
- Kapazität pro Fahrstreifen ist ein fester Richtwert (1800 Fz/h, HCM-Standard),
  keine Berücksichtigung von Ampeln/Kreuzungskapazität.
- Beim Städte-Import werden Wege an gerundeten Koordinaten zu Kreuzungen
  zusammengeführt; sehr dicht beieinanderliegende, eigentlich getrennte Punkte
  könnten in seltenen Fällen fälschlich verschmelzen.

Gute Ansatzpunkte für weitere Features (z.B. in eigenen Branches): Einbahnstraßen,
Ampel-/Kreuzungsmodellierung, echte Verkehrszähldaten statt manueller Nachfrage,
Export/Import von Netzwerken als JSON, mehrere gleichzeitige Sperrungen vergleichen.

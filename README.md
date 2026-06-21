# Responsive Multi-Label Worker Template für AWS Ground Truth

Ein responsives, smartphone-taugliches Worker-Task-Template für **AWS SageMaker
Ground Truth**, um Textdatensätze mit **mehreren Labels** (Multi-Label /
Multi-Class-Multi-Label) zu annotieren – ohne Scrollen zum Labeln/Absenden,
augenschonend, und vorbereitet für **PWA** und **LLM/Classifier-Pre-Labeling**.

## Inhalt

| Datei | Zweck |
|---|---|
| `template.liquid.html` | **Primäres** GT-Template. Eigenes responsives No-Scroll-Layout (Chips + sticky Footer), volle Kontrolle über UX, Pre-Labeling-fähig. |
| `template.multiselect.liquid.html` | Variante mit dem **nativen** `crowd-classifier-multi-select`-Element (Standard-GT-Output-Format). |
| `standalone/` | **PWA-fähige** Standalone-Web-App (gleiches UI) zum Entwickeln/Vorschauen und für spätere Eigenhostung inkl. direkter LLM-Anbindung. |
| `examples/input.manifest.jsonl` | Beispiel-Input-Manifest für einen Custom-Labeling-Job. |

---

## 1. Recherche: Was brauchen GT Worker Templates?

Ein Worker-Task-Template besteht aus **HTML + CSS + JavaScript + Liquid + Crowd
HTML Elements**:

- **Crowd HTML Elements** (`https://assets.crowd.aws/crowd-html-elements.js`)
  liefern fertige UI-Bausteine und die Submit-Logik. Alles muss in
  `<crowd-form>` liegen – das übernimmt das Absenden an Ground Truth.
- Für Multi-Label-Text gibt es das fertige Element
  **`crowd-classifier-multi-select`** (Mehrfachauswahl mehrerer Kategorien,
  optionale `exclusion-category` = „keine zutreffend“).
- **Liquid** speist Daten aus dem Input-Manifest ein:
  - Text: `{{ task.input.taskObject }}`
  - Labels: `categories="{{ task.input.labels | to_json | escape }}"`
- Eigene Submit-Buttons sind möglich: versteckter `<crowd-button form-action="submit" style="display:none">`
  plus eigener Button, der `document.querySelector('crowd-form').submit()` aufruft.

### Wichtige technische Einschränkung (Sandbox)

Im **echten Job** rendert Ground Truth das Template in einem **sandboxed iframe**
(`sandbox="allow-scripts allow-same-origin allow-forms"`). Daraus folgt:

- **`fetch`/XHR sind blockiert** – aus dem Template heraus kann **kein** Modell-
  Endpoint zur Laufzeit aufgerufen werden.
- In der **Konsolen-Vorschau** gibt es diese Sandbox nicht → Code kann in der
  Vorschau funktionieren, im echten Job aber scheitern. Immer mit einem echten
  (Test-)Job verifizieren.

Quellen: AWS-Doku zu Crowd HTML Elements, `crowd-classifier-multi-select`,
„Creating a custom worker task template“ und „Text Classification (Multi-label)“.

---

## 2. Akzeptanzkriterien – Umsetzung

| Kriterium | Umsetzung |
|---|---|
| **Kein Scrollen zum Labeln/Absenden** | Vollbild-Flex-Layout (`100dvh`): kompakter Header oben, Labels + **sticky Footer** mit „Absenden“/„Überspringen“ immer sichtbar. |
| **Textdatensatz passt i. d. R. auf den Screen; sonst Container scrollbar, während Labels/Buttons sichtbar bleiben** | Nur die Text-Region (`.doc`) scrollt (`flex:1; min-height:0; overflow:auto`). Labels und Footer bleiben fix sichtbar. |
| **Smartphone-tauglich** | Mobile-first, `dvh` (kein URL-Bar-Springen), `env(safe-area-inset-*)` (Notch), Touch-Targets ≥ 44px, `viewport-fit=cover`. |
| **PWA-Support später** | Standalone-Variante mit `manifest.webmanifest` + Service Worker + Icons (siehe Abschnitt 4). |
| **Augenschonende, eher weiße Farben** | Helle Palette (Weiß/sehr helles Grau), entsättigtes Teal-Blau als Akzent, geringer Glanz; optionaler Dark-Mode via `prefers-color-scheme`. |
| **Später LLM/Classifier-Pre-Labeling** | `task.input.preLabels` werden vorangehakt und als „Vorschlag“ markiert; Architektur siehe Abschnitt 5. |

---

## 3. Nutzung in Ground Truth (Custom Labeling Job)

1. **Input-Manifest** anlegen (eine JSON-Zeile pro Datensatz), z. B.
   `examples/input.manifest.jsonl`:

   ```json
   {"source":"Die Lieferung kam zu spät, der Service war aber freundlich.","taskObject":"Die Lieferung kam zu spät, der Service war aber freundlich.","labels":["Positiv","Negativ","Neutral","Lieferung","Kundenservice","Produktqualität","Frage","Beschwerde"]}
   ```

   > Hinweis: Das Template liest `task.input.taskObject` und `task.input.labels`.
   > Wenn du `source` statt `taskObject` verwendest, passe die Liquid-Variable im
   > Template an (`{{ task.input.source }}`) oder mappe per Pre-Annotation-Lambda.

2. **Template hochladen**: `template.liquid.html` (oder die Multi-Select-Variante)
   nach S3 laden und beim API-Call als `UiTemplateS3Uri` angeben – oder den
   Inhalt im Konsolen-Template-Editor (Custom workflow) einfügen.

3. **Labeling-Job** als *Custom* erstellen, Worker-Team (z. B. Private) zuweisen.

4. **Vorschau** im Editor prüfen und anschließend mit einem echten Test-Job
   verifizieren (Sandbox-Unterschied beachten).

### Output-Format

- **`template.liquid.html`**: Feld `multiLabelAnnotations` (JSON-String):

  ```json
  {"labels":["Lieferung","Kundenservice"],"noneOfTheAbove":false,"prelabeled":true,"modified":true}
  ```

  Die einzelnen Checkboxen werden zusätzlich nativ mitgesendet (Fallback).

- **`template.multiselect.liquid.html`**: GT-Standardformat
  `{"multiLabel":{"labels":["..."]}}`.

---

## 4. PWA-Support – Machbarkeit & Umsetzung

**Im eingebetteten GT-Worker-Portal: nicht möglich.** Das Portal läuft auf einer
AWS-Domain, im Sandbox-iframe und ohne Möglichkeit, einen eigenen Service Worker
oder ein Manifest zu registrieren.

**Als selbst gehostete Web-App: möglich und vorbereitet.** Der Ordner
`standalone/` enthält dasselbe UI als installierbare PWA:

- `manifest.webmanifest` (Name, Icons inkl. maskable, `display: standalone`),
- `service-worker.js` (App-Shell-Caching → Offline-Betrieb; POSTs werden nie
  gecacht, Offline-Queue via `localStorage`-Stub),
- Icons (`icons/`).

Lokal testen (Service Worker braucht http/https, nicht `file://`):

```bash
cd standalone
python3 -m http.server 8080
# Browser: http://localhost:8080
```

Diese Standalone-App ist auch die Basis, falls du den Worker-Flow künftig
**außerhalb** von Ground Truth betreiben willst (eigenes Backend, eigene
Queue, eigenes Auth).

---

## 5. LLM/Classifier-Pre-Labeling – Machbarkeit & Architektur

**Direkt aus dem GT-Template heraus: nicht möglich** (Sandbox blockt Netzwerk).
Stattdessen zwei tragfähige Wege:

### Weg A (empfohlen): Pre-Annotation-Lambda

```
Input-Manifest ──▶ GT Labeling Job ──▶ Pre-Annotation-Lambda
                                         │  ruft LLM/Classifier
                                         │  (z. B. Amazon Bedrock oder
                                         │   SageMaker-Endpoint) auf
                                         ▼
                          taskInput = { taskObject, labels, preLabels }
                                         │
                                         ▼
                         Template liest {{ task.input.preLabels }}
                         und hakt die Labels vor (Worker korrigiert)
```

- Die Lambda erhält pro Datensatz das Manifest-Objekt, ruft das Modell auf und
  gibt zusätzlich `preLabels: ["..."]` in `taskInput` zurück.
- Das Template (`template.liquid.html`) hakt diese Labels vorab an und markiert
  sie als „Vorschlag“. Ground Truth trackt im Output, ob der Worker den
  Vorschlag geändert hat (`modified`).

### Weg B: Pre-Labels offline vorberechnen

Pre-Labels in einem Batch-Job berechnen und direkt ins Input-Manifest schreiben
(`"preLabels":["..."]`). Kein Lambda nötig, aber statisch.

### Standalone-App (kein Sandbox-Limit)

In `standalone/app.js` ist `fetchPreLabels()` vorbereitet: setze
`CONFIG.preLabelEndpoint` auf dein Backend (`POST {text, labels}` →
`{labels:[...]}`). Ohne Endpoint greift eine lokale Keyword-Heuristik als Demo.

### Optional: Automated Data Labeling (Active Learning)

Ground Truth kann zusätzlich per Active Learning Teile des Datensatzes
automatisch labeln (sinnvoll ab ~5.000 Objekten). Das ersetzt nicht das
Pre-Labeling im UI, kann aber kombiniert werden.

---

## 6. Anpassen

- **Labels** kommen aus dem Manifest (`labels`). Fallback-Demo-Labels nur, wenn
  keine geliefert werden.
- **Exklusiv-Option** („Keine zutreffend“): in `template.liquid.html` via
  `EXCLUSION_LABEL` / `REQUIRE_SELECTION` konfigurierbar.
- **Farben**: zentral über CSS-Variablen (`:root`).
- **Pflichtauswahl**: `REQUIRE_SELECTION` (Template) bzw.
  `CONFIG.requireSelection` (Standalone).

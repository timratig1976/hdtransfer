# 🏍️ Harley Davidson → HubSpot Import Project

Zwei-teilige Anwendung zum Scrapen von Harley Davidson Bike-Daten und Import in HubSpot.

## 📋 Übersicht

Das Projekt besteht aus zwei separaten Anwendungen mit eigenen Web-UIs:

### 1. **HD Scraper** (Port 3636)
Lädt Bike-Daten von der Harley Davidson Media Kit Website herunter:
- Bike-Informationen (Name, Jahr, Kategorie, Beschreibung)
- Technische Spezifikationen
- Bilder (Preview-Qualität)
- Videos (MP4)
- PDF-Spezifikationen

### 2. **HD Importer** (Port 3838)
Importiert die gescrapten Daten in HubSpot:
- Upload von Bildern, Videos und PDFs zu HubSpot File Manager
- Erstellt Custom Objects in HubSpot
- Verknüpft Medien mit Bike-Objekten

## 🚀 Schnellstart

### Alle Server starten
```bash
node start.js
```

Dies startet beide Anwendungen gleichzeitig:
- **Scraper**: http://localhost:3636
- **Importer**: http://localhost:3838

### Einzelne Server starten

**Nur Scraper:**
```bash
node hd_scraper_server.js
```

**Nur Importer:**
```bash
node hd_import_server.js
```

## 📁 Projektstruktur

```
hdimport/
├── start.js                    # Launcher für beide Server
├── hd_scraper_server.js        # Scraper Backend
├── hd_scraper_app.html         # Scraper UI
├── hd_import_server.js         # Importer Backend
├── hd_import_app.html          # Importer UI
├── hd_scraper_test.js          # Test-Script (1 Bike)
├── hd-output/                  # Output-Verzeichnis
│   ├── 2026_pan_america_1250_special_ra1250s/
│   │   ├── data.json           # Bike-Metadaten
│   │   ├── images/             # Heruntergeladene Bilder
│   │   ├── videos/             # Heruntergeladene Videos
│   │   └── specs_*.pdf         # PDF-Spezifikationen
│   ├── scrape_results.json     # Scraping-Ergebnisse
│   └── import_result.json      # Import-Ergebnisse
└── README.md
```

## 🔧 Workflow

### Schritt 1: Bikes scrapen

1. Öffne http://localhost:3636
2. Konfiguriere Output-Verzeichnis (Standard: `./hd-output`)
3. Filtere nach Jahr/Kategorie (optional)
4. Klicke "Katalog laden" → zeigt verfügbare Bikes
5. Wähle gewünschte Bikes aus
6. Klicke "Scraping starten"
7. Warte bis alle Bikes heruntergeladen sind

**Ergebnis:** Jedes Bike wird in einem eigenen Ordner gespeichert mit:
- `data.json` - Alle Metadaten
- `images/` - Produktbilder
- `videos/` - B-Roll Videos
- `specs_*.pdf` - Technische Spezifikationen

### Schritt 2: In HubSpot importieren

1. Öffne http://localhost:3838
2. Konfiguriere:
   - **API Token**: HubSpot Private App Token (pat-eu1-...)
   - **Object Type ID**: Custom Object Type ID (z.B. 0-420)
   - **Input Verzeichnis**: Pfad zu gescrapten Daten (Standard: `./hd-output`)
3. Optional: Filtere nach Model Code oder Jahr
4. Klicke "Bikes laden" → zeigt verfügbare Bikes aus dem Output-Verzeichnis
5. Wähle Bikes zum Import aus
6. Klicke "Import starten"
7. Beobachte den Fortschritt in Echtzeit

**Ergebnis:** Für jedes Bike wird:
- Ein HubSpot Custom Object erstellt
- Alle Medien hochgeladen und verknüpft
- Properties gesetzt (Name, Jahr, Kategorie, Specs, etc.)

## 🎯 Features

### Scraper UI
- ✅ Bike-Katalog mit 20+ Modellen (2026)
- ✅ Filter nach Jahr und Kategorie
- ✅ Multi-Select für Batch-Scraping
- ✅ Echtzeit-Fortschrittsanzeige
- ✅ Live-Log mit farbcodierten Meldungen
- ✅ Automatische Duplikat-Erkennung (überspringt existierende Dateien)

### Importer UI
- ✅ Automatische Bike-Erkennung aus Output-Verzeichnis
- ✅ Filter nach Model Code und Jahr
- ✅ Multi-Select für Batch-Import
- ✅ 4-Stufen-Fortschritt (Bilder → Videos → PDF → HubSpot)
- ✅ Echtzeit-Log via Server-Sent Events
- ✅ Zusammenfassung mit Erfolgs-/Fehlerstatistik
- ✅ Session-Storage für API Token

### Backend
- ✅ Rate Limiting (350ms zwischen Downloads/Uploads)
- ✅ Fehlerbehandlung mit detailliertem Logging
- ✅ Automatische Dateinamen-Sanitization
- ✅ Strukturierte Ordner-Hierarchie in HubSpot
- ✅ JSON-Export der Ergebnisse

## 📊 HubSpot Integration

### Custom Object Properties

Die folgenden Properties werden beim Import gesetzt:

| Property | Typ | Beschreibung |
|----------|-----|--------------|
| `name` | String | Bike-Name |
| `url_slug` | String | URL-freundlicher Slug |
| `modelljahr` | String | Modelljahr (z.B. 2026) |
| `kategorie` | String | Kategorie (Touring, Cruiser, etc.) |
| `beschreibung` | Text | Marketing-Beschreibung |
| `abmessungen` | Text | Technische Spezifikationen |
| `hero_bild` | File | Haupt-Produktbild (File ID) |
| `galerie` | String | Weitere Bilder (File IDs, `;`-getrennt) |
| `video` | File | B-Roll Video (File ID) |
| `broschure` | File | PDF-Spezifikationen (File ID) |
| `finanzierungsrechner` | URL | Link zum Finanzierungsrechner |
| `versicherungen` | URL | Link zur Versicherungsberechnung |

### File Manager Struktur

```
/hd-media/
  └── {year}/
      └── {category}/
          └── {bike-slug}/
              ├── images/
              │   ├── {year}_{slug}_image1.jpg
              │   └── {year}_{slug}_image2.jpg
              ├── videos/
              │   └── {year}_{slug}_b-roll.mp4
              └── docs/
                  └── {year}_{slug}_specs.pdf
```

## 🔑 HubSpot Setup

### 1. Private App erstellen
1. HubSpot → Settings → Integrations → Private Apps
2. Erstelle neue Private App
3. Scopes auswählen:
   - `crm.objects.custom.read`
   - `crm.objects.custom.write`
   - `files`
4. Token kopieren (beginnt mit `pat-eu1-...`)

### 2. Custom Object Type erstellen
1. HubSpot → Settings → Data Management → Objects
2. Erstelle Custom Object "Bikes" (oder ähnlich)
3. Füge alle benötigten Properties hinzu (siehe Tabelle oben)
4. Notiere die Object Type ID (z.B. `0-420`)

## 🎨 UI Design

Beide UIs verwenden ein modernes, dunkles Design im Harley Davidson Stil:
- **Farben**: Orange (#E8621A) auf schwarzem Hintergrund
- **Fonts**: Space Mono (monospace) + Syne (sans-serif)
- **Layout**: Sidebar + Main Content mit Live-Updates
- **Responsive**: Optimiert für Desktop-Nutzung

## 🛠️ Technische Details

### Dependencies
- **Node.js**: Built-in Module (https, http, fs, path, url)
- **Keine externen NPM-Pakete erforderlich**

### API Endpoints

**Scraper:**
- `GET /` - Serve UI
- `GET /events` - SSE Stream
- `GET /api/catalog` - Bike-Katalog
- `POST /api/scrape` - Start Scraping

**Importer:**
- `GET /` - Serve UI
- `GET /events` - SSE Stream
- `GET /api/bikes` - Gescrapte Bikes
- `POST /api/import` - Start Import

### Datenformat (data.json)

```json
{
  "year": "2026",
  "category": "Adventure Touring",
  "name": "Pan America 1250 Special",
  "code": "ra1250s",
  "url": "https://h-dmediakit.com/eu/bdp/?ra1250s|2026",
  "description": "...",
  "specs": {
    "Engine": "Revolution Max 1250",
    "Displacement": "1252 cc",
    ...
  },
  "images": [
    {
      "previewUrl": "https://s3-eu-west-2.amazonaws.com/...",
      "caption": "...",
      "localFile": "image1.jpg",
      "status": "downloaded"
    }
  ],
  "videos": [...],
  "specsPdf": "https://...",
  "pdfLocal": "specs_ra1250s_2026_eu.pdf"
}
```

## 📝 Bike-Katalog (2026)

Aktuell verfügbare Modelle:

- **Adventure Touring**: Pan America 1250, Pan America 1250 Special
- **Cruiser**: Street Bob 114, Fat Bob 114, Low Rider S, Breakout 117
- **Touring**: Road Glide, Road Glide Special, Street Glide, Street Glide Special, Road King, Road King Special, Ultra Limited, Electra Glide Ultra Classic
- **Sportster**: Nightster, Sportster S
- **CVO**: CVO Road Glide, CVO Street Glide
- **Trike**: Tri Glide Ultra, Freewheeler

## 🐛 Troubleshooting

**Problem: Server startet nicht**
- Prüfe ob Ports 3636/3838 bereits belegt sind
- Lösung: Ändere PORT-Konstante in den Server-Dateien

**Problem: Scraping schlägt fehl**
- Prüfe Internetverbindung
- Prüfe ob h-dmediakit.com erreichbar ist
- Prüfe Schreibrechte für Output-Verzeichnis

**Problem: Import schlägt fehl**
- Prüfe HubSpot API Token (muss gültig sein)
- Prüfe Object Type ID (muss existieren)
- Prüfe File Upload Limits in HubSpot

**Problem: Dateien werden nicht heruntergeladen**
- Bereits existierende Dateien >1KB werden übersprungen
- Lösche Output-Verzeichnis für kompletten Neustart

## 📄 Lizenz

Internes Tool für Harley Davidson Daten-Management.

## 🤝 Support

Bei Fragen oder Problemen, siehe Logs in:
- `./hd-output/scrape_results.json`
- `./hd-output/import_result.json`
- `./hd-output/import_log.txt`

# Installation — Remote Camera AI

Dieser Leitfaden bringt den kompletten Stack (Web, API, Vision, WhatsApp-Sidecar, TURN) per Docker auf einem einzelnen Host zum Laufen. Der Stack ist für einen Mac mini im Heimnetz ausgelegt, läuft aber auf jedem Linux/macOS-Rechner mit Docker.

---

## 1. Mindest-Systemvoraussetzungen

| Komponente | Minimum | Empfohlen |
|---|---|---|
| **CPU** | 4 Kerne, AVX2-Support | Apple Silicon (M1/M2/M4) oder x86_64 mit 8 Kernen |
| **RAM** | 8 GB | 16 GB |
| **Speicher** | 35 GB frei (Docker-Images + Modelle) | 60 GB (mit Alert-Archiv + Puffer) |
| **OS** | macOS 13+, Ubuntu 22.04+, Debian 12+ | macOS 15+ / Ubuntu 24.04 |
| **Docker** | Docker Desktop 4.25+ oder Docker Engine 25+ | Docker Desktop 4.35+ oder Docker Engine 27+ |
| **Docker Compose** | v2.20+ (in Docker Desktop enthalten) | v2.30+ |
| **Netzwerk** | Gigabit-Ethernet oder 5-GHz-WLAN im Heimnetz | Gigabit-Ethernet für den Host |
| **Browser am Viewer** | Chrome/Edge 120+, Safari 17+ | aktuellstes Chrome/Safari |
| **Android-Kamera-Handy** | Chrome 120+, Android 10+ | Chrome 147+, Android 13+ |
| **iOS-Kamera-Handy** | Safari 17+ unter iOS 17+ | Safari 18+ unter iOS 18+ |

**Allgemeine Hinweise:**
- Für echte Kamera-Nutzung am Handy (Android **oder** iOS) ist HTTPS Pflicht — ohne sicheren Kontext bleibt `getUserMedia()` gesperrt.
- Der erste `docker compose up --build` lädt mehrere GB herunter. Plane beim Erststart ~30 Minuten auf einer 100-Mbit-Leitung ein. Folgende Builds nutzen Docker-Layer-Cache und sind deutlich schneller.

**Download-Größen pro Service (nach dem ersten Build):**

| Service | Image-Größe | Herkunft |
|---|---|---|
| `vision` | **~24 GB** | `python:3.13-slim` (~120 MB) + PyTorch CPU (~1 GB) + Ultralytics + YOLO26n (~10 MB) + YOLOE-26x-seg (~250 MB) + MobileCLIP2_b (~100 MB) + BioCLIP 2 (~500 MB) + CUDA-Bibliotheken und Caches |
| `api` | ~530 MB | `node:24-bookworm-slim` + Fastify 5 + deps |
| `whatsapp` | ~520 MB | `node:22-slim` + Baileys + deps |
| `coturn` | ~240 MB | Upstream `coturn/coturn:4.6.3` |
| `web` | ~90 MB | `nginxinc/nginx-unprivileged:1.29-alpine` + gebundeltes SPA |
| **Summe** | **~25 GB** | einmalig beim Erststart, danach gecacht |

Zusätzlich werden beim Vision-Build die Modellgewichte fest ins Image eingebrannt, damit der Container ohne Internet starten kann. Ein einmaliger Download von ~4 GB (Gewichte) + ~20 GB (Base-Image + Python-Wheels) ist daher normal. Bei `docker compose build --no-cache` werden diese Downloads wiederholt — vermeiden, wenn nicht zwingend nötig.

**SAM 3 (optional, manuelle Einrichtung):**

SAM 3 (Segment Anything Model 3) ist von Meta auf [Hugging Face](https://huggingface.co/facebook/sam3) veröffentlicht und **nicht frei herunterladbar** — Meta verlangt die Zustimmung zu seinen Nutzungsbedingungen. Der Download funktioniert nur mit einem Hugging-Face-Account und nach Akzeptanz des Model-Lizenz-Gates.

Schritt für Schritt:

1. [Hugging-Face-Account](https://huggingface.co/join) anlegen (kostenlos, E-Mail-Bestätigung).
2. Auf der [SAM-3-Model-Card](https://huggingface.co/facebook/sam3) die Lizenz lesen und „Agree and access repository" klicken.
3. Einen persönlichen **Read-Token** unter <https://huggingface.co/settings/tokens> erzeugen (Type: Read).
4. Das Ultralytics-kompatible Weight-File `sam3.pt` herunterladen (z. B. via `huggingface-cli` oder direkt im Browser aus den Files im Repo).
5. Die Datei unter `vision/models/sam3.pt` ablegen — der Vision-Container mountet diesen Ordner als `/app/extra-models` im Read-only-Modus.
6. Den Vision-Container neu starten: `docker compose restart vision`. In den Startup-Logs sollte `sam3 loaded` erscheinen.

Ohne `sam3.pt` bleibt der SAM-3-Schritt in der Pipeline automatisch inaktiv und YOLOE-26x ist der stärkste aktive Verifier. Die Gesamtfunktion der App ist nicht beeinträchtigt — SAM 3 verbessert nur die Präzision der Segmentierung bei schwierigen Szenen (Blätter, Reflexionen, teilweise verdeckte Tiere).

**Plattform-Unterschiede am Kamera-Handy:**

| Feature | Android (Chrome 120+) | iOS (Safari 17+) |
|---|---|---|
| Rückkamera | ✅ | ✅ |
| Screen Wake Lock (Display bleibt an) | ✅ | ⚠️ erst ab iOS 16.4 |
| Hardware-Zoom (3-Stufen-Preset) | ✅ | ❌ (nicht in `MediaTrackCapabilities` exponiert) |
| Torch / Taschenlampe | ✅ (wo Gerät das unterstützt) | ❌ |
| Dritt-Browser (Firefox, Edge, Chrome) | eigene Engine, meist kompatibel | alle zwangsweise WebKit → verhalten sich wie Safari |
| Eingehende Telefonanrufe | Stream pausiert kurz, setzt oft auf | Stream endet dauerhaft — „Kamera starten" muss manuell neu gedrückt werden |
| Home-Screen-PWA | OK | ❌ empfohlen zu vermeiden (Kamera-Zugriff im PWA-Modus instabil) |

---

## 2. Setup-Checkliste

Schritt für Schritt. Stoppe bei einem Häkchen, das nicht funktioniert, und behebe das Problem, bevor du weitergehst.

### A. Vorbereitung

- [ ] Docker Desktop / Docker Engine installiert und läuft: `docker version` zeigt Client + Server.
- [ ] Docker Compose v2 vorhanden: `docker compose version` (nicht `docker-compose`).
- [ ] Repository geklont: `git clone <repo-url> && cd remote-camera-ai`.
- [ ] `.env.example` als Vorlage genutzt: `cp .env.example .env`.
- [ ] `.env` mit realen Werten gefüllt (mindestens `GOOGLE_API_KEY` für Gemini-Narration ODER `LLM_PROVIDER=stub` für Tests).
- [ ] Optional: `WHATSAPP_ENABLED=true` gesetzt, wenn du WhatsApp-Alerts willst.

### B. Profile wählen

Zwei fertige Profile liegen bei:

- **LAN-Profil (Mac mini + Android im Heimnetz)** → Clients erreichen den Stack über `macmini.local` oder die feste LAN-IP.
  ```bash
  docker compose up -d --build
  ```
- **Docker-Desktop-Profil (alles auf dem Entwicklungs-Rechner)** → API und Web auf `localhost`.
  ```bash
  docker compose --env-file .env.docker-desktop.example up -d --build
  ```

### C. Healthchecks

- [ ] Alle Container gesund: `docker compose ps` zeigt `healthy` bei `api`, `vision`, `whatsapp` und `Up` bei `web`, `coturn`.
- [ ] API antwortet: `curl -sS http://localhost:8080/api/health` gibt `{"ok":true}` zurück.
- [ ] Frontend lädt: Browser-Aufruf `http://localhost:3000` (Desktop-Profil) bzw. `http://macmini.local:3000` (LAN) zeigt die Startseite.

### D. HTTPS für Kamera-Handy einrichten (nur LAN-Profil)

Android Chrome und iOS Safari geben `getUserMedia()` nur in einem sicheren Kontext frei. Für den echten Kamera-Sender brauchst du also HTTPS. Das lokale CA-Zertifikat ist **nicht zwingend nötig** — ohne installierte CA zeigt der Browser bei jedem `https://<LAN-IP>`-Aufruf die Warnung „Ihre Verbindung ist nicht privat" und du musst dich über „Erweitert" → „Weiter zu …" klicken. Mit installierter CA entfällt die Warnung komplett und die App startet ohne Extra-Klicks.

- [ ] Zertifikate erzeugen (Beispiel mit eigener LAN-IP):

  ```bash
  ./scripts/generate-dev-cert.sh <LAN-IP> macmini.local
  ```

- [ ] Stack neu starten (Zertifikate werden erst beim Build eingebunden):

  ```bash
  docker compose up -d --build web
  ```

- [ ] CA-Zertifikat am Kamera-Handy laden: `http://<LAN-IP>:3000/local-ca.crt` aufrufen.
- [ ] CA-Zertifikat als vertrauenswürdig installieren:
  - **Android:** Einstellungen → Biometrie/Sicherheit → Weitere Sicherheitseinstellungen → Vom Speicher installieren → Datei wählen → als CA-Zertifikat markieren.
  - **iOS:** Profil wird beim Download angeboten → Einstellungen → Profil geladen → Installieren → danach Einstellungen → Allgemein → Info → Zertifikatsvertrauenseinstellungen → volles Vertrauen aktivieren.
- [ ] Danach die App nur noch unter `https://<LAN-IP>` öffnen.

### E. Erster End-to-End-Test

- [ ] Auf der Startseite **„Neue Session starten"** klicken — zwei Links werden erzeugt (Kamera-Link + Viewer-Link).
- [ ] Viewer-Link auf einem Desktop-Browser öffnen. Status „Warte auf Kamera-Sender" erscheint.
- [ ] Kamera-Link auf dem Handy öffnen. Kamera-Zugriff zulassen. „Kamera starten" tippen.
- [ ] Im Viewer erscheint der Live-Stream nach 2–5 Sekunden.
- [ ] Ein Vogel/eine Person ins Bild bewegen — im Viewer erscheint unter „Alarm-Übersicht" ein Treffer.
- [ ] Falls WhatsApp konfiguriert: Nachricht landet am Handy.

### F. Optional: SAM 3 und WhatsApp

- [ ] **SAM 3** (optional, für präzisere Segmentierung): Hugging-Face-Schritte aus Abschnitt 1 (Mindest-Systemvoraussetzungen → SAM 3) befolgen und `sam3.pt` unter `vision/models/sam3.pt` ablegen. Ohne die Datei bleibt der Schritt inaktiv — die App funktioniert trotzdem vollständig.
- [ ] **WhatsApp-Pairing:** Auf der Startseite QR-Code scannen, sobald `WHATSAPP_ENABLED=true` gesetzt ist. Nur einmal pro Gerät nötig; Baileys legt die Session in `./data/whatsapp-auth/` ab.

---

## 3. Häufige Probleme

| Symptom | Wahrscheinliche Ursache | Fix |
|---|---|---|
| Container `api` läuft nicht, Exit-Code 1 | `.env` fehlt oder enthält ungültige URLs | `.env.example` kopieren, `PUBLIC_WEB_URL` / `PUBLIC_API_URL` setzen |
| Android-Browser zeigt „Kamera gesperrt" | Nicht im sicheren Kontext | Über `https://<LAN-IP>` öffnen statt `http://` |
| Viewer bleibt auf „Warte auf Kamera" | Peer kann sich nicht verbinden | Gleiches WLAN prüfen; macOS-Firewall für Docker freigeben |
| Vision-Build dauert ewig beim ersten Mal | Modelle werden heruntergeladen (~4 GB) | Einmalig — beim zweiten Build werden sie gecacht |
| Alerts kommen nicht als WhatsApp-Nachricht | `data/whatsapp-auth/` leer oder QR nicht gescannt | Startseite öffnen und per Baileys-QR pairen |
| Session-Links zeigen auf `localhost` statt `<LAN-IP>` | Startseite über `localhost` aufgerufen | Startseite über Mac-mini-Host/IP aufrufen, dann sind auch Links korrekt |

---

## 4. Deinstallation

```bash
docker compose down --volumes --remove-orphans
docker image prune -af --filter 'label=com.docker.compose.project=remote-camera-ai'
rm -rf data/ certs/dev/*.pem
```

---

## 5. Wo gehen Daten hin?

- **Sessions** → `data/sessions.json` (Host-Volume, 72 h TTL, per `SESSION_TTL_HOURS` anpassbar).
- **Snapshots** → `data/snapshots/<sessionId>/` (FIFO, max 200 Events/Session).
- **Archiv (permanent)** → `data/archive/<YYYY-MM-DD>/` mit `events.jsonl` für spätere Model-Fine-Tunings.
- **WhatsApp-Auth** → `data/whatsapp-auth/` (Baileys-Session, sensitiv, nicht ins Repo einchecken).

Alle Pfade sind `.gitignore`d. Lösche sie nicht im laufenden Betrieb.

# Remote Camera AI

Eine moderne WebRTC-Webapp, mit der ein Android-Smartphone im Browser als Remote-Kamera arbeitet und ein zweites Android-Geraet den Live-Stream sieht. Alle Services laufen lokal per Docker Compose auf dem Mac mini in eurer Dev-Umgebung. Optional laeuft parallel eine lokale KI-Pipeline fuer Motion Detection und Objekterkennung, damit bei Bewegung und Zielobjekten wie `bird` ein Alarm inkl. Snapshot ausgeloest werden kann.

## Stack

- Frontend: React 19.2, Vite 8, React Router 7, TypeScript 6
- API/Signaling: Fastify 5, WebSocket Signaling, sichere Session-Tokens
- Vision: FastAPI 0.135, OpenCV 4.13, Ultralytics 8.4 mit motion-gated YOLO26n, ROI-fokussiertem YOLOE26-X-Verifier und optionalem SAM-3-Refinement
- Realtime: WebRTC fuer den Live-View, REST fuer Snapshot-Analyse
- Deployment: Docker Compose mit getrennten Services fuer Web, API, Vision und optional TURN

## Schnellstart

1. `.env.example` nach `.env` kopieren.
2. `PUBLIC_WEB_URL`, `PUBLIC_API_URL`, `WEB_ORIGIN` und `ICE_TURN_URLS` auf den Hostnamen oder die LAN-IP des Mac mini setzen, z. B. `http://macmini.local:3000`.
3. Beide Android-Geraete und der Mac mini muessen im gleichen WLAN sein.
4. Optional `TURN_EXTERNAL_IP` auf die echte LAN-IP des Mac mini setzen.
5. Starten:

```bash
docker compose up --build
```

Optional fuer maximale Einzelobjekt-Praezision:

1. Lege `sam3.pt` unter [vision/models/.gitkeep](/Users/geri/_GIT_REPOS/remote-camera-ai/vision/models/.gitkeep) bzw. praktisch als `vision/models/sam3.pt` ab.
2. Der `vision`-Service mountet diesen Ordner nach `/app/extra-models`, sodass SAM 3 ohne weiteren Codewechsel aktiv wird.
3. Ohne lokale `sam3.pt` bleibt der SAM-3-Schritt automatisch inaktiv; YOLOE26-X bleibt dann der staerkste aktive Verifier.

6. Webapp ueber den Mac-mini-Hostnamen oder seine LAN-IP oeffnen, z. B. `http://macmini.local:3000`.
7. Eine Session erzeugen.
8. Den `Camera Link` auf dem Android-Smartphone oeffnen, das als Kamera dient.
9. Den `Viewer Link` auf dem zweiten Android-Geraet oeffnen.

## HTTPS Live-Test im LAN

1. Zertifikate erzeugen:

```bash
./scripts/generate-dev-cert.sh 192.168.178.39 macmini.local
```

2. Stack neu starten:

```bash
docker compose --env-file .env.docker-desktop.example up -d --build
```

3. Auf dem Android-Geraet zuerst das lokale CA-Zertifikat laden:

```text
http://192.168.178.39:3000/local-ca.crt
```

4. Das geladene CA-Zertifikat auf dem Android-Geraet als vertrauenswuerdige CA installieren.
5. Danach die App nur noch ueber die sichere URL oeffnen:

```text
https://192.168.178.39
```

6. Session erzeugen und den Camera-Link scannen oder direkt oeffnen.

## Docker Desktop Testmodus

Fuer lokale Tests direkt auf dem Mac mini oder Entwicklungsrechner:

```bash
docker compose --env-file .env.docker-desktop.example up --build
```

Dann sind Web und API unter `localhost` erreichbar. Genau dieses Profil wurde fuer die aktuellen Container-Smoke-Tests verwendet.

## Browser E2E

Ein echter Browser-Flow ist mit Playwright hinterlegt. Dabei werden Viewer und Kamera in Chromium gestartet, WebRTC aufgebaut und Detection ueber eine bewegte Fake-Kameraquelle verifiziert.

```bash
docker compose --env-file .env.docker-desktop.example up -d --build
npm install
npm run test:e2e
```

## Reale Kamera im gleichen WLAN

- Wenn eure echte Remote-Kamera im selben WLAN wie der Mac mini ist, nutzt fuer beide Android-Geraete die Mac-mini-Adresse wie `http://macmini.local:3000` oder die feste LAN-IP.
- Fuer den echten Kamera-Sender auf Android nutzt nach Zertifikat-Import die HTTPS-Adresse wie `https://192.168.178.39`.
- In diesem LAN-Szenario klappt WebRTC oft schon direkt ueber Host-Kandidaten; `coturn` bleibt trotzdem als Fallback aktiv.
- Fuer die echte Kamera-Freigabe am Android-Geraet muss der Browser im Vordergrund bleiben und die Kamera-Permission einmal bestaetigt werden.
- Fuer Android als Kamera-Sender reicht HTTP ueber die LAN-IP nicht aus. Die Kamera-Seite muss per HTTPS in einem vertrauenswuerdigen Kontext geoeffnet werden.
- Das lokale CA-Zertifikat ist absichtlich ueber `http://<macmini-ip>:3000/local-ca.crt` erreichbar, damit ihr es vor dem HTTPS-Aufruf bequem aufs Android laden koennt.
- Fuer den eigentlichen App-Zugriff reicht im LAN der Frontend-Port `3000`. Das Frontend leitet `/api` und `/ws` intern an den API-Container weiter.
- Session-Links werden automatisch mit genau dem Host und Port erzeugt, ueber den ihr die Startseite aufruft. Wenn ihr also `http://192.168.178.39:3000` nutzt, zeigen auch Camera- und Viewer-Link auf diese Adresse.
- Wenn ihr die App ueber `https://192.168.178.39` oeffnet, zeigen die Session-Links automatisch ebenfalls auf diese sichere Adresse.
- Wenn `ICE_TURN_URLS` im Desktop-Profil auf `localhost` stehen, werden diese fuer Browser-Clients automatisch auf den aktuell aufgerufenen Mac-mini-Host umgeschrieben.
- Die Ports `3000`, `3478/tcp`, `3478/udp` und `49160-49200/udp` sind im Compose-Setup explizit auf `0.0.0.0` veroeffentlicht und damit im lokalen Netzwerk ueber den Mac mini erreichbar.
- Zusaetzlich ist HTTPS auf `443/tcp` und alternativ `3443/tcp` veroeffentlicht.
- Port `8080` bleibt fuer direkte API-Diagnosen ebenfalls im LAN erreichbar, wird fuer Kamera und Viewer aber nicht benoetigt.

## LAN Checkliste

1. Den Mac mini per `macmini.local` oder fester LAN-IP vom Android-Geraet aus anpingen oder im Browser aufrufen.
2. Sicherstellen, dass die macOS-Firewall eingehende Verbindungen fuer Docker Desktop nicht blockiert.
3. Die App immer ueber `http://<macmini-name-oder-ip>:3000` oeffnen, nicht ueber `localhost`.
4. Nach Env-Aenderungen den Stack neu bauen, damit das statische Frontend mit der richtigen Netzkonfiguration ausgeliefert wird.

## Sicherheits-Defaults

- Session-spezifische Viewer- und Camera-Tokens
- CORS-Allowlist statt `*`
- Security-Header via Helmet und statischem Webserver
- Request-Rate-Limit auf dem API-Service
- Container ohne Linux-Capabilities und mit `no-new-privileges`
- `read_only`-Root-Filesystem fuer Web/API/Vision
- Keine nativen Mobile-Permissions ausser Browser-Kamera

## Funktionsumfang

- Live-View ueber WebRTC
- Smartphone als Kamera-Sender mit Rueckkamera-Priorisierung
- Kamera-Schalter, Torch/Zoom sofern Browser/Geraet das via Media Constraints unterstuetzt
- Motion Detection mit konfigurierbarem Threshold
- Motion-Gating vor der Objekterkennung, damit YOLO nicht auf jedem Sample laufen muss
- Track-aware Bestaetigung ueber mehrere Frames, damit kurzzeitige Fehltrigger seltener werden
- ROI-Refinement auf bewegten Bildbereichen fuer kleine oder weiter entfernte Objekte
- Open-vocabulary Praezisions-Zweitpass mit YOLOE26-X fuer maximal praezise Einzelobjekt-Erkennung aus Texteingaben
- Optionaler SAM-3-Nachcheck auf fokussierten ROIs fuer noch strengere Trigger-Bestaetigung bei vorhandener `sam3.pt`
- Zielobjekt-Filter, z. B. `bird`
- Snapshot bei Trigger und Anzeige im Viewer
- Wake Lock fuer stabile laengere Aufnahmen auf mobilen Geraeten
- Detection-Details im UI, inkl. Vision-Modell und ob YOLO im jeweiligen Frame wirklich gelaufen ist
- Detection-Details im UI, inkl. Vision-Modell, Tracking-Bestaetigung und ROI-Refinement
- Detection-Details im UI, inkl. Praezisions-Verifier-Modell, Modus und verwendetem Prompt
- Detection-Details im UI, inkl. SAM-3-Verfuegbarkeit, Modell, Modus und Prompt

### WhatsApp alerts

A new sidecar service (`whatsapp`) runs a headless Chromium + whatsapp-web.js
session. On first boot open the homepage and scan the QR code with your
phone (WhatsApp → Einstellungen → Verknüpfte Geräte). Enter a recipient
phone number in E.164 format (`+49…`) and toggle alerts on. After that every
minted alert is pushed to that number as a short text. Auth persists in
`./data/whatsapp-auth`. Set `WHATSAPP_ADMIN_TOKEN` in `.env` — the web UI
asks for it once and stores it locally.

## Grenzen der reinen Web-Loesung

- HTTPS ist fuer `getUserMedia()` ausserhalb von `localhost` Pflicht.
- Viewer, API und Signaling funktionieren im lokalen Netz auch ueber HTTP; der Kamera-Zugriff auf Android jedoch nicht.
- Die App sollte im Vordergrund bleiben; Hintergrundbetrieb und gesperrter Bildschirm sind auf mobilen Browsern nicht verlaesslich.
- Feingranulare Kamera-Features wie Torch, Zoom oder manueller Fokus sind browser- und geraeteabhaengig.
- Fuer echte Internet-Szenarien ist TURN oft noetig; im Compose-Setup ist `coturn` deshalb enthalten.

## Modell-Empfehlung

Die Realtime-Erkennung sollte lokal auf dem Vision-Service laufen, nicht ueber ein externes LLM. Falls ihr zu Alerts noch Bildzusammenfassungen oder natuerlichsprachige Erklaerungen wollt, verwendet die App bewusst das in `LLM_MODEL` konfigurierte Modell aus eurer Env-Datei. Details stehen in der Webapp und im Abschlussbericht.

## Android-Logik

- Android A ist der Kamera-Sender und nutzt bevorzugt die Rueckkamera.
- Android B ist der Viewer und zeigt nur den Stream und Alerts.
- Der Mac mini hostet Web, API, Vision und optional TURN lokal.
- Die Session-Links muessen immer auf den Mac mini zeigen, niemals auf `localhost` des Smartphones.

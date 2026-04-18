# Remote Camera AI

> 📦 **Erstinstallation:** Die vollständige Schritt-für-Schritt-Anleitung inkl. Mindest-Systemvoraussetzungen, Setup-Checkliste, HTTPS-Einrichtung und Troubleshooting findest du in **[INSTALLATION.md](./INSTALLATION.md)**. Dieses README hier ist die Kurz-Referenz; für einen sauberen Erststart bitte zuerst `INSTALLATION.md` durchgehen.

> ⚖️ **Lizenz-Kurzfassung:** Dieses Projekt steht unter der **[PolyForm Noncommercial License 1.0.0](./LICENSE)**. Private, schulische, karitative und nicht-kommerzielle Nutzung ist erlaubt — **kommerzielle Nutzung ist ausdrücklich untersagt** und nur mit schriftlicher Genehmigung des Autors zulässig. Die Software wird **ohne jegliche Gewährleistung** bereitgestellt; der Autor übernimmt **keine Haftung** für Schäden aus Nutzung oder Fehlkonfiguration. Details siehe Abschnitt [Lizenz & Haftungsausschluss](#lizenz--haftungsausschluss) am Ende dieser Datei.

Eine moderne WebRTC-Webapp, mit der ein Smartphone im Browser als Remote-Kamera arbeitet und ein beliebiger Browser im Heimnetz den Live-Stream sieht. **Unterstützt werden Android (Chrome ab 120) und iOS (Safari ab 17).** Alle Services laufen lokal per Docker Compose auf dem Mac mini in eurer Dev-Umgebung. Optional läuft parallel eine lokale KI-Pipeline für Motion Detection und Objekterkennung, damit bei Bewegung und Zielobjekten wie `bird` ein Alarm inkl. Snapshot ausgelöst werden kann.

## Stack

- Frontend: React 19.2, Vite 8, React Router 7, TypeScript 6
- API/Signaling: Fastify 5, WebSocket Signaling, sichere Session-Tokens
- Vision: FastAPI 0.135, OpenCV 4.13, Ultralytics 8.4 mit motion-gated YOLO26n, ROI-fokussiertem YOLOE26-X-Verifier und optionalem SAM-3-Refinement
- Realtime: WebRTC für den Live-View, REST für Snapshot-Analyse
- Deployment: Docker Compose mit getrennten Services für Web, API, Vision und optional TURN

## Schnellstart

1. `.env.example` nach `.env` kopieren.
2. `PUBLIC_WEB_URL`, `PUBLIC_API_URL`, `WEB_ORIGIN` und `ICE_TURN_URLS` auf den Hostnamen oder die LAN-IP des Mac mini setzen, z. B. `http://macmini.local:3000`.
3. Kamera-Handy (Android oder iOS), Viewer-Gerät und Mac mini müssen im gleichen WLAN sein.
4. Optional `TURN_EXTERNAL_IP` auf die echte LAN-IP des Mac mini setzen.
5. Starten:

```bash
docker compose up --build
```

Optional für maximale Einzelobjekt-Präzision — **SAM 3** hinzufügen:

1. Kostenlosen Hugging-Face-Account anlegen: <https://huggingface.co/join>.
2. Auf der Model-Card <https://huggingface.co/facebook/sam3> die Lizenz akzeptieren (Button „Agree and access repository"). Ohne diese Zustimmung ist der Download gesperrt.
3. `sam3.pt` herunterladen und unter `vision/models/sam3.pt` ablegen.
4. Der `vision`-Service mountet diesen Ordner als `/app/extra-models`, sodass SAM 3 beim nächsten `docker compose restart vision` ohne weiteren Codewechsel aktiv wird.
5. Ohne lokale `sam3.pt` bleibt der SAM-3-Schritt automatisch inaktiv; YOLOE26-X bleibt dann der stärkste aktive Verifier — die App funktioniert vollständig.

Detaillierte Schritte (inkl. Read-Token + CLI-Variante) stehen in [INSTALLATION.md → SAM 3](./INSTALLATION.md#1-mindest-systemvoraussetzungen).

6. Webapp über den Mac-mini-Hostnamen oder seine LAN-IP öffnen, z. B. `http://macmini.local:3000`.
7. Eine Session erzeugen.
8. Den Kamera-Link auf dem Smartphone öffnen, das als Kamera dient (Chrome auf Android oder Safari auf iOS).
9. Den Viewer-Link auf einem beliebigen Browser im gleichen Heimnetz öffnen (Desktop, Laptop, Tablet, zweites Handy).

## HTTPS Live-Test im LAN

> **Hinweis zum CA-Zertifikat:** Das lokale CA-Zertifikat zu installieren ist **nicht zwingend nötig**, macht den Alltag aber deutlich angenehmer. Ohne installierte CA zeigt der Browser bei jedem Aufruf von `https://<LAN-IP>` die Warnung „Ihre Verbindung ist nicht privat" und man muss jedes Mal über „Erweitert" → „Weiter zu …" auf die Seite klicken. Mit installierter CA entfällt die Warnung komplett.

1. Zertifikate erzeugen:

```bash
./scripts/generate-dev-cert.sh <LAN-IP> macmini.local
```

2. Stack neu starten:

```bash
docker compose --env-file .env.docker-desktop.example up -d --build
```

3. Auf dem Kamera-Handy zuerst das lokale CA-Zertifikat laden (gilt für Android wie iOS):

```text
http://<LAN-IP>:3000/local-ca.crt
```

4. CA-Zertifikat als vertrauenswürdig installieren:
   - **Android:** Einstellungen → Biometrie/Sicherheit → Weitere Sicherheitseinstellungen → Vom Speicher installieren → als CA-Zertifikat markieren.
   - **iOS:** Profil wird beim Download angeboten → Einstellungen → Profil geladen → Installieren → danach Einstellungen → Allgemein → Info → Zertifikatsvertrauenseinstellungen → volles Vertrauen aktivieren.
5. Danach die App nur noch über die sichere URL öffnen:

```text
https://<LAN-IP>
```

6. Session erzeugen und den Camera-Link scannen oder direkt öffnen.

## Docker Desktop Testmodus

Für lokale Tests direkt auf dem Mac mini oder Entwicklungsrechner:

```bash
docker compose --env-file .env.docker-desktop.example up --build
```

Dann sind Web und API unter `localhost` erreichbar. Genau dieses Profil wurde für die aktuellen Container-Smoke-Tests verwendet.

## Browser E2E

Ein echter Browser-Flow ist mit Playwright hinterlegt. Dabei werden Viewer und Kamera in Chromium gestartet, WebRTC aufgebaut und Detection über eine bewegte Fake-Kameraquelle verifiziert.

```bash
docker compose --env-file .env.docker-desktop.example up -d --build
npm install
npm run test:e2e
```

## Reale Kamera im gleichen WLAN

- Wenn eure echte Remote-Kamera im selben WLAN wie der Mac mini ist, nutzt für Kamera-Handy und Viewer-Gerät die Mac-mini-Adresse wie `http://macmini.local:3000` oder die feste LAN-IP.
- Für den echten Kamera-Sender (Android oder iOS) die HTTPS-Adresse `https://<LAN-IP>` verwenden; ohne HTTPS sperren Chrome und Safari den Zugriff auf `getUserMedia()`.
- In diesem LAN-Szenario klappt WebRTC oft schon direkt über Host-Kandidaten; `coturn` bleibt trotzdem als Fallback aktiv.
- Für die Kamera-Freigabe am Handy muss der Browser im Vordergrund bleiben und die Kamera-Permission einmal bestätigt werden. Auf iOS muss die Permission zusätzlich bei jedem App-Neustart erneut bewilligt werden.
- Das lokale CA-Zertifikat ist absichtlich über `http://<macmini-ip>:3000/local-ca.crt` erreichbar, damit ihr es vor dem HTTPS-Aufruf bequem aufs Handy laden könnt.
- Für den eigentlichen App-Zugriff reicht im LAN der Frontend-Port `3000`. Das Frontend leitet `/api` und `/ws` intern an den API-Container weiter.
- Session-Links werden automatisch mit genau dem Host und Port erzeugt, über den ihr die Startseite aufruft. Wenn ihr also `http://<LAN-IP>:3000` nutzt, zeigen auch Camera- und Viewer-Link auf diese Adresse.
- Wenn ihr die App über `https://<LAN-IP>` öffnet, zeigen die Session-Links automatisch ebenfalls auf diese sichere Adresse.
- Wenn `ICE_TURN_URLS` im Desktop-Profil auf `localhost` stehen, werden diese für Browser-Clients automatisch auf den aktuell aufgerufenen Mac-mini-Host umgeschrieben.
- Die Ports `3000`, `3478/tcp`, `3478/udp` und `49160-49200/udp` sind im Compose-Setup explizit auf `0.0.0.0` veröffentlicht und damit im lokalen Netzwerk über den Mac mini erreichbar.
- Zusätzlich ist HTTPS auf `443/tcp` und alternativ `3443/tcp` veröffentlicht.
- Port `8080` bleibt für direkte API-Diagnosen ebenfalls im LAN erreichbar, wird für Kamera und Viewer aber nicht benötigt.

## LAN Checkliste

1. Den Mac mini per `macmini.local` oder fester LAN-IP vom Kamera-Handy (Android oder iOS) aus anpingen oder im Browser aufrufen.
2. Sicherstellen, dass die macOS-Firewall eingehende Verbindungen für Docker Desktop nicht blockiert.
3. Die App immer über `http://<macmini-name-oder-ip>:3000` öffnen, nicht über `localhost`.
4. Nach Env-Änderungen den Stack neu bauen, damit das statische Frontend mit der richtigen Netzkonfiguration ausgeliefert wird.

## Sicherheits-Defaults

- Session-spezifische Viewer- und Camera-Tokens
- CORS-Allowlist statt `*`
- Security-Header via Helmet und statischem Webserver
- Request-Rate-Limit auf dem API-Service
- Container ohne Linux-Capabilities und mit `no-new-privileges`
- `read_only`-Root-Filesystem für Web/API/Vision
- Keine nativen Mobile-Permissions außer Browser-Kamera

## Funktionsumfang

- Live-View über WebRTC
- Smartphone als Kamera-Sender mit Rückkamera-Priorisierung
- Kamera-Schalter, Torch/Zoom sofern Browser/Gerät das via Media Constraints unterstützt
- Motion Detection mit konfigurierbarem Threshold
- Motion-Gating vor der Objekterkennung, damit YOLO nicht auf jedem Sample laufen muss
- Track-aware Bestätigung über mehrere Frames, damit kurzzeitige Fehltrigger seltener werden
- ROI-Refinement auf bewegten Bildbereichen für kleine oder weiter entfernte Objekte
- Open-vocabulary Präzisions-Zweitpass mit YOLOE26-X für maximal präzise Einzelobjekt-Erkennung aus Texteingaben
- Optionaler SAM-3-Nachcheck auf fokussierten ROIs für noch strengere Trigger-Bestätigung bei vorhandener `sam3.pt`
- Zielobjekt-Filter, z. B. `bird`
- Snapshot bei Trigger und Anzeige im Viewer
- Wake Lock für stabile längere Aufnahmen auf mobilen Geräten
- Detection-Details im UI, inkl. Vision-Modell und ob YOLO im jeweiligen Frame wirklich gelaufen ist
- Detection-Details im UI, inkl. Vision-Modell, Tracking-Bestätigung und ROI-Refinement
- Detection-Details im UI, inkl. Präzisions-Verifier-Modell, Modus und verwendetem Prompt
- Detection-Details im UI, inkl. SAM-3-Verfügbarkeit, Modell, Modus und Prompt

### WhatsApp-Alerts

Ein Sidecar-Service (`whatsapp`) spricht über [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys) direkt mit dem WhatsApp-Protokoll — **kein Chromium, keine Web-View**. Öffne die Startseite, warte auf den QR-Code und scanne ihn mit deinem Handy (WhatsApp → Einstellungen → Verknüpfte Geräte → Gerät verknüpfen). Danach Telefonnummer im E.164-Format (`+49…`) eintragen, Alerts aktivieren — jeder Treffer wird als kurze Textnachricht an dein Handy gepusht. Auth-Daten liegen verschlüsselt in `./data/whatsapp-auth/` und überleben Container-Neustarts.

## Grenzen der reinen Web-Lösung

### Allgemein

- HTTPS ist für `getUserMedia()` außerhalb von `localhost` Pflicht — sowohl auf Android Chrome als auch auf iOS Safari.
- Viewer, API und Signaling funktionieren im lokalen Netz auch über HTTP; der Kamera-Zugriff auf den mobilen Browsern jedoch nicht.
- Die Kamera-Seite muss im Vordergrund bleiben; Hintergrundbetrieb und gesperrter Bildschirm sind auf mobilen Browsern nicht verlässlich (siehe plattformspezifische Hinweise unten).
- Für echte Internet-Szenarien ist TURN oft nötig; im Compose-Setup ist `coturn` deshalb enthalten.

### Android (Chrome ab 120)

- Hardware-Zoom (3-Stufen-Preset im Kamera-UI) und Torch/Taschenlampe sind über `MediaTrackCapabilities` verfügbar, sobald Chrome die Rückkamera freigegeben hat. Einzelne Hersteller liefern unterschiedliche Zoom-Ranges — Samsung/Pixel/OnePlus haben eigene Kurven.
- Die Screen-Wake-Lock-API ist voll unterstützt: solange die Kamera-Seite läuft, geht der Bildschirm nicht in den Standby.
- Chrome auf Android backgroundet den Tab aggressiv: wenn der User die Kamera-Seite verlässt, stoppt `setTimeout` / `setInterval` — der WebRTC-Stream bleibt dennoch kurz aktiv, bricht aber bei längerem Hintergrundbetrieb ab.

### iOS (Safari ab 17, iOS 17+)

- Alle Browser auf iOS nutzen zwangsweise die WebKit-Engine. Chrome, Firefox und Edge verhalten sich deshalb **wie Safari**; eine separate Engine wie auf Android gibt es nicht.
- `MediaTrackCapabilities.torch` und `MediaTrackCapabilities.zoom` werden von Safari **nicht** exponiert. Das 3-Stufen-Zoom-Preset und die Torch-Taste erscheinen in der UI deshalb nicht. Physischer Zoom geht nur über den iOS-Kameraschieber vor dem Start der Webseite — nicht mehr aus der App heraus.
- Screen Wake Lock ist erst **ab iOS 16.4** verfügbar. Auf älteren Geräten sperrt sich der Bildschirm nach Systemvorgabe (typisch 30 s bis 5 min) und die Kamera-Seite schläft ein. Für Dauerbetrieb daher iOS 16.4+ verwenden und die Automatische-Sperre auf „Nie" stellen.
- Safari verlangt für `getUserMedia()` eine Nutzer-Interaktion (Klick auf „Kamera starten") und setzt Autoplay für Video nur zu, wenn das Element `muted` ist — das ist im Code bereits berücksichtigt.
- Eingehende Telefonanrufe unterbrechen den Kamera-Track endgültig. Nach dem Anruf muss „Kamera starten" erneut gedrückt werden; ein automatisches Wiederaufsetzen leistet iOS Safari nicht.
- Die Kamera-Seite sollte **nicht** als Home-Screen-PWA installiert werden — der Kamera-Zugriff verhält sich im PWA-Modus auf iOS noch ungleichmäßig und kann beim Wechsel zwischen Apps die Stream-Kopplung verlieren.

## Modell-Empfehlung

Die Realtime-Erkennung sollte lokal auf dem Vision-Service laufen, nicht über ein externes LLM. Falls ihr zu Alerts noch Bildzusammenfassungen oder natürlichsprachige Erklärungen wollt, verwendet die App bewusst das in `LLM_MODEL` konfigurierte Modell aus eurer Env-Datei. Details stehen in der Webapp und im Abschlussbericht.

## Geräte-Logik

- **Kamera-Sender** ist ein Smartphone — Android (Chrome 120+) **oder** iOS (Safari 17+). Die App wählt automatisch die Rückkamera, soweit das Gerät sie exponiert.
- **Viewer** ist ein beliebiger Browser im gleichen Heimnetz: Desktop, Laptop, Tablet oder zweites Smartphone. Der Viewer zeigt nur den Stream und die Alerts — er braucht keine Kamera.
- Der **Mac mini** hostet Web, API, Vision, WhatsApp-Sidecar und optional TURN vollständig lokal.
- Die Session-Links müssen immer auf den Mac mini zeigen, niemals auf `localhost` des Smartphones.
- Platform-Caveats: Zoom/Torch funktionieren nur auf Android, Wake Lock nur auf Android und iOS 16.4+, eingehende Telefonanrufe beenden den Kamera-Stream auf iOS dauerhaft (siehe Abschnitt [Grenzen der reinen Web-Lösung](#grenzen-der-reinen-web-lösung)).

## Lizenz & Haftungsausschluss

Dieses Projekt ist unter der **[PolyForm Noncommercial License 1.0.0](./LICENSE)** veröffentlicht. Die vollständige, rechtsverbindliche Fassung liegt in der Datei [`LICENSE`](./LICENSE) im Repo-Root. Die folgende Zusammenfassung ist **keine** rechtliche Erklärung, sondern nur eine Orientierung.

### Was ist erlaubt (ohne separate Genehmigung)

- **Private Nutzung** für eigene Zwecke zu Hause, als Hobby-Projekt oder zum persönlichen Lernen.
- **Experimente und Forschung** an Universitäten, Schulen und öffentlichen Forschungsinstituten.
- **Nutzung durch gemeinnützige Organisationen** (Vereine, NGOs, karitative Organisationen, Behörden, Organisationen für öffentliche Sicherheit, Gesundheit oder Umweltschutz) — unabhängig von deren Finanzierungsquelle.
- **Änderungen, Forks und abgeleitete Werke** zu diesen nicht-kommerziellen Zwecken, solange die Lizenz und der Copyright-Hinweis mit weitergegeben werden.

### Was ist nicht erlaubt

- **Kommerzielle Nutzung in jeglicher Form** — weder das direkte Weiterverkaufen der Software noch das Einbetten in ein kostenpflichtiges Produkt, ein Kundenprojekt, einen SaaS-Dienst oder einen anderen gewinnorientierten Kontext.
- Eine Firmenlizenz oder ein Rechtenaustausch mit Dritten **ohne vorherige schriftliche Zustimmung** des Autors.

### Kommerzielle Nutzung anfragen

Für gewerbliche Einsätze, Custom-Lizenzen oder Partnerschaften bitte ein GitHub-Issue mit dem Label `commercial-license-request` öffnen: <https://github.com/geraldfehringer/remote-camera-ai/issues/new>. Ohne eine separate, schriftliche Vereinbarung bleibt jede kommerzielle Verwendung ein Lizenzverstoß.

### Gewährleistung & Haftung

Die Software wird **„wie besehen" („as is")** bereitgestellt. Soweit gesetzlich zulässig übernimmt der Autor **keinerlei Gewährleistung** und **keine Haftung** für direkte oder indirekte Schäden, Datenverluste, entgangene Gewinne, Fehlalarme der KI-Pipeline, nicht ausgelöste Alerts, falsch übermittelte WhatsApp-Nachrichten oder sonstige Folgen aus der Installation, der Konfiguration oder dem Betrieb dieses Projekts. Nutzung erfolgt auf eigenes Risiko und in eigener Verantwortung.

Wer die Software in einem sicherheitsrelevanten Kontext einsetzen möchte (Einbruchsschutz, Überwachung von Kindern/Tieren, medizinische Zwecke etc.), ist selbst dafür verantwortlich, die Zuverlässigkeit für seinen Anwendungsfall zu prüfen. Die KI-Pipeline ist ein Experiment und kein zertifiziertes Sicherheitssystem.

### Datenschutz-Hinweis

Das Projekt verarbeitet Kamera-Bildmaterial und schickt bei Alert-Ereignissen Bild und Kontext an den konfigurierten LLM-Anbieter (Standard: Google Gemini). Wer die Software im Geltungsbereich der DSGVO oder vergleichbarer Regelungen einsetzt, ist selbst Verantwortlicher im Sinne der Verordnung und muss alle erforderlichen Einwilligungen, Verträge zur Auftragsverarbeitung und Hinweispflichten eigenständig erfüllen. Der Autor stellt dafür keine Vorlagen bereit.

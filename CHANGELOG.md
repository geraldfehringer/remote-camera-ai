# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres loosely to [Semantic Versioning 2.0.0](https://semver.org/).
Entries are ordered newest first.

> **Contribution policy:** After the first public release, new entries here are added
> only via a merged pull request that references a GitHub issue. Ad-hoc local changes
> without an issue/PR trail do not belong in this file — they should be captured as an
> issue first, implemented on a branch, and only then appear in `[Unreleased]`.

## [Unreleased]

### Added
- **License & liability**: Added `LICENSE` file with the full [PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0) plus a German "Lizenz & Haftungsausschluss" section in `README.md`. Private, educational, research, and nonprofit use are permitted without extra paperwork; commercial use requires a written agreement with the author (request via a GitHub issue labelled `commercial-license-request`). Software ships "as is" with no warranty and no liability for damage arising from use or misconfiguration. Users in GDPR territory remain the data controller for any camera footage and LLM traffic.
- **Remote target control from viewer**: A dropdown on the Viewer page sends a `control` WebSocket message that the camera device picks up on its next detect tick. Same five targets as the camera-side dropdown (bird / cat / squirrel / person / motion-only).
- **German alert narration** hardcoded across the stack. LLM narration (Gemini / Claude / OpenAI / Together) is instructed to always emit the `shortSummary` in German with proper Umlaute and grammar. No additional translation call — the language is a prompt variant.
- **INSTALLATION.md** with minimum system requirements and a step-by-step setup checklist for a public audience.
- **CHANGELOG.md** (this file) as the single source for release notes going forward.

### Changed
- All UI strings across the dashboard, Camera page, and Viewer page normalised to German with proper Umlaute (`ä`, `ö`, `ü`, `ß`) instead of ASCII fallbacks (`ae`, `oe`, `ue`, `ss`). Affects hero copy, pipeline explanations, diagnostics labels, action buttons, alert-feed headers, and error messages.
- Viewer page: "Fernsteuerung" card now only exposes the target dropdown. The "Aktuelle Einstellung" card below it shows the live pipeline target vs. the viewer-requested target so users see immediately that a remote change actually took effect.
- Server `localeFromTarget` hard-codes `'de'` so every LLM narration call produces German regardless of the raw target label the camera sent.

### Removed
- **Remote zoom control from viewer**. The feature would have required converting `applyZoomLevel` to `useEffectEvent` and writing to a ref mid-render inside `CameraPage`. Both patterns turned out to destabilise the Android Chrome camera page — an unhandled error there releases the Screen Wake Lock, the phone locks, and the kiosk becomes unrecoverable without physical access. Dropped on purpose.
- All LAN IPs (`192.168.178.*`) and personal references removed from tracked files (README, App.tsx, `.env.example`, docs). Replaced with `<LAN-IP>` placeholders to make the repo safe for public release.
- **`docs/superpowers/`** (planning + spec notes from local Claude Code workflows) removed from tracking and added to `.gitignore`. The directory is also purged from the full git history via `git filter-repo` ahead of the public release, so neither working trees nor `git log` expose internal design iterations.

### Fixed
- `POST /api/whatsapp/logout` no longer trips Fastify's `FST_ERR_CTP_EMPTY_JSON_BODY` — the proxy helper only emits `content-type: application/json` when a body is present.

### Security
- Verified via full tracked-file secret scan (`scripts/secret-scan.cjs`) that no real API keys, passwords, tokens, certificates, or personal data are committed.
- Confirmed `.gitignore` covers `.env`, `data/whatsapp-auth/`, `certs/dev/*.pem`, `vision/models/*.pt`, and snapshot/archive directories.
- Removed the real LAN IP (`192.168.178.39`) from README, App.tsx error message, and design docs ahead of making the repo public.

---

## [0.1.0] — 2026-04-17

Initial private snapshot.

### Added
- WebRTC remote camera pipeline: an Android/iOS phone streams its rear camera via `getUserMedia` + `RTCPeerConnection`; any browser in the LAN can view live.
- Fastify 5 + `@fastify/websocket` signaling server with perfect-negotiation (`description` / `candidate` relay, peer-ready on both sockets present, 4409 "replaced by newer connection" on duplicate role).
- Vision pipeline (FastAPI + Ultralytics): motion gate → YOLO26n → ROI refine → YOLOE-26x precision verifier → optional SAM 3 → BioCLIP 2 species classification → optional MegaDetector.
- Per-target detection profiles so "just pick a target" works for bird / cat / squirrel / person without tweaking sliders.
- LLM narration layer supporting Gemini, Claude, OpenAI, Together, and a stub provider. Per-session budget + per-hour rate limit. Image + event context sent to the LLM; short summary + threat level (0/1/2) + false-positive flag returned.
- Alert minting with per-trackId cooldown (15 s default) and per-target fallback cooldown (60 s) so the same bird doesn't spam the feed.
- Persistent event archive under `data/archive/<YYYY-MM-DD>/` with `events.jsonl` for later fine-tuning.
- WhatsApp sidecar (`@whiskeysockets/baileys`, no Chromium) with QR-pair flow on the homepage, rate limiting, and fire-and-forget dispatch from the alert mint path.
- `coturn` service shipped in-compose for TURN relay; empty TURN by default on LAN.
- Playwright E2E spec covering viewer + camera negotiation with a fake Y4M source.
- Local Claude Code automation: pre-commit secret-scan hook (`scripts/secret-scan.cjs`), project CLAUDE.md, per-task memory directory.

[Unreleased]: https://github.com/<org>/remote-camera-ai/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/<org>/remote-camera-ai/releases/tag/v0.1.0

# Redirect Checker — Copilot Instructions

## Project Overview

This is a **tech support scam hunter** — an automated Discord bot that detects and reports malicious redirect chains and scam pages. It crawls ads across search engines and adult sites, follows redirects with stealth browser automation, classifies landing pages with an AI model, and reports confirmed scams to security services (Google Safe Browsing, Netcraft, Microsoft SmartScreen, etc.) while tracking takedown status.

## Environment Setup

- **Node.js**: Use `nvm use` before running anything — the project uses `.nvmrc` set to `lts/*` (currently Node 24).
- **Package manager**: Yarn 4 (Berry / modern Yarn). Use `yarn` to install dependencies and `yarn <script>` to run scripts. Do **not** use `npm`.
- **TypeScript**: ESM modules (`"type": "module"` in package.json), compiled with `tsc`.
- **Testing**: Vitest (`yarn vitest` or `npx vitest`).

## High-Level Architecture

### Entry Point

`src/discordBot.ts` — initializes the Discord client, starts all long-running schedulers (redirect monitoring, ad hunting, batch reporting, takedown monitoring, pruning), and coordinates shutdown.

### Hunters (Ad Discovery)

Four independent hunters find scam ads from different sources:

- **SearchAdHunter** — scrapes syndicated search network ads from SERP iframes
- **TyposquatHunter** — visits typosquatted domains from `typosquats.json`
- **PornhubAdHunter** — fetches ads via Pornhub's ad API
- **AdSpyGlassHunter** — triggers popunder ads on adult sites using AdSpyGlass

Each hunter follows redirect chains, screenshots the final page, runs the AI classifier, checks signals, and alerts Discord if a scam is confirmed.

### Scam Decision Logic

A page is flagged as a scam when **both** conditions are met:

1. AI classifier confidence ≥ 90% (ResNet18 ONNX model at `models/scam_classifier.onnx`)
2. At least one weighted signal is triggered (fullscreen request, keyboard lock, pointer lock, third-party hosting, IP address hosting, or worker bomb)

### Key Services

| Service | Role |
|---------|------|
| `SignalService` | Detects suspicious page behaviors (fullscreen, keyboard lock, third-party hosting, etc.) |
| `AIClassifierService` | Runs screenshot through ONNX ResNet18 model for scam classification |
| `BrowserRedirectService` | Follows HTTP redirects with stealth browser (Patchright) |
| `BrowserReportService` | Takes screenshots of URLs for AI analysis |
| `RedirectMonitorService` | Periodically checks monitored redirect destinations |
| `ReportService` / `BatchReportService` | Reports confirmed scams to Google, Netcraft, Microsoft, CRDF |
| `TakedownMonitorService` | Tracks when security services flag reported URLs |
| `AlertService` | Posts scam alerts to Discord channels |
| `SchedulerService` | Manages periodic task execution |

### Browser Automation

Uses **Patchright** (stealth Playwright fork) with anti-detection: spoofed user agents, blocked analytics, random mouse movements, WebGL fingerprint spoofing, and proxy rotation.

### Database

PostgreSQL — schema in `src/schema.sql`. Stores redirects, redirect destinations, scam reports, takedown status, hunter events, and redirect events.

### Discord Commands

Located in `src/commands/`: add/remove redirects, view redirect logs, hunter logs, report URLs, check status, view scam stats, and takedown status.

## Key Technologies

- **Patchright** (stealth Playwright fork) for browser automation
- **ONNX Runtime** for ML inference
- **Discord.js** for bot framework
- **PostgreSQL** (`pg`) for persistence
- **tldts** for domain parsing and third-party hosting detection
- **Vitest** for testing
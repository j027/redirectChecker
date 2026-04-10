# Redirect Checker — Copilot Instructions

## Project Overview

This is a **tech support scam hunter** — an automated Discord bot that detects and reports malicious redirect chains and scam pages. It crawls ads across search engines and adult sites, follows redirects with stealth browser automation, classifies landing pages with an AI model, and reports confirmed scams to security services (Google Safe Browsing, Netcraft, Microsoft SmartScreen, etc.) while tracking takedown status.

## Environment Setup

- **Node.js**: Use `nvm use` before running anything — the project uses `.nvmrc` set to `lts/*` (currently Node 24).
- **Package manager**: Yarn 4 (Berry / modern Yarn). Use `yarn` to install dependencies and `yarn <script>` to run scripts. Do **not** use `npm`.
- **TypeScript**: ESM modules (`"type": "module"` in package.json), compiled with `tsc`.
- **Testing**: Vitest (`yarn vitest` or `npx vitest`).
- **Deployment**: systemd user service (`discord-bot.service`) — runs `yarn run build && yarn run start` on start. Logs via `journalctl --user -xeu discord-bot --no-pager`.

## High-Level Architecture

### Entry Point

`src/discordBot.ts` — initializes the Discord client, starts all long-running schedulers (redirect monitoring, ad hunting, takedown monitoring, URLScan hunting, pruning, Safe Browsing hash sync), and coordinates shutdown.

### Hunters (Ad Discovery)

Five independent hunters find scam ads from different sources:

- **SearchAdHunter** — scrapes syndicated search network ads from SERP iframes
- **TyposquatHunter** — visits typosquatted domains from `typosquats.json`
- **PornhubAdHunter** — fetches ads via Pornhub's ad API
- **AdSpyGlassHunter** — triggers popunder ads on adult sites using AdSpyGlass
- **UrlscanHunter** — polls the urlscan.io live feed for suspicious URLs

Each hunter follows redirect chains, screenshots the final page, runs the AI classifier, checks signals, and alerts Discord if a scam is confirmed.

### Scam Decision Logic

The scam decision varies by source:

- **Redirect Monitor**: A page is flagged as scam when the AI classifier says scam AND confidence ≥ 90%. Signals are tracked but **not required** for the decision.
- **URLScan Hunter**: Additionally requires at least one weighted signal (fullscreen request, keyboard lock, pointer lock, third-party hosting, IP address hosting, or worker bomb).
- **Ad Hunters**: Same as URLScan — requires both classifier confidence ≥ 90% and at least one weighted signal.

AI classifier: ResNet18 ONNX model at `models/scam_classifier.onnx`, confidence threshold constant `CONFIDENCE_THRESHOLD = 0.90`.

### Key Services

| Service | Role |
|---------|------|
| `SignalService` | Detects suspicious page behaviors (fullscreen, keyboard lock, third-party hosting, etc.) |
| `AIClassifierService` | Runs screenshot through ONNX ResNet18 model for scam classification |
| `BrowserRedirectService` | Follows HTTP redirects with stealth browser (Patchright) |
| `BrowserReportService` | Takes screenshots of URLs for AI analysis |
| `BrowserManagerService` | Shared browser lifecycle utilities (health checks, restart, close) |
| `RedirectMonitorService` | Periodically checks monitored redirect destinations |
| `ReportService` | Reports confirmed scams to Netcraft, Google Safe Browsing, VirusTotal, Kaspersky, MetaDefender, SmartScreen, CheckPhish, Hybrid Analysis, URLScan, Cloudflare URL Scanner, CRDF Labs, and Google Web Risk |
| `SafeBrowsingV5Service` | Syncs Google Safe Browsing v5 hash lists and checks URLs against threat types |
| `TakedownMonitorService` | Tracks when security services flag reported URLs |
| `ChromeUserAgentService` | Fetches latest Chrome version for realistic user agent strings |
| `SchedulerService` | Manages periodic task execution with timeouts and abort controllers |

### Scheduler Services

The `SchedulerService` runs these periodic tasks:

| Task | Interval | Description |
|------|----------|-------------|
| Redirect Checker | 60s | Follows monitored redirects and classifies destinations |
| Ad Hunter | 60s | Runs all four ad hunters (search, typosquat, pornhub, adspyglass) in parallel |
| URLScan Hunter | configurable | Polls urlscan.io feed for suspicious URLs |
| Takedown Monitor | periodic | Checks if reported scam URLs have been taken down |
| Redirect Pruner | daily | Removes stale redirects (no scams in 5 days or DNS failure) |
| Event Log Pruner | daily | Cleans up old hunter and redirect event logs |
| Hash List Sync | periodic | Syncs Google Safe Browsing v5 hash lists |

### Browser Automation

Uses **Patchright** (stealth Playwright fork) with anti-detection: spoofed user agents, blocked analytics, random mouse movements, WebGL fingerprint spoofing, and proxy rotation. Each hunter and the redirect checker have their own browser instance, restarted before each cycle to prevent lingering state.

### Database

PostgreSQL — schema in `src/schema.sql`. Stores redirects, redirect destinations, scam reports, takedown status, hunter events, redirect events, and Safe Browsing hash lists.

### Discord Commands

Located in `src/commands/`: add/remove redirects, view redirect logs, hunter logs, report URLs, check status, view scam stats (daily/monthly), takedown status, and URLScan stats.

## Key Technologies

- **Patchright** (stealth Playwright fork) for browser automation
- **ONNX Runtime** for ML inference
- **Discord.js** for bot framework
- **PostgreSQL** (`pg`) for persistence
- **tldts** for domain parsing and third-party hosting detection
- **protobufjs** for Google Safe Browsing v5 protocol buffers
- **Vitest** for testing
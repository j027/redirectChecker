# Tech Support Scam Hunter

An automated system that hunts tech support scams by following malicious ad redirects across the web. It monitors scam campaigns, classifies fraudulent sites with AI, reports them to security services, and tracks their takedown status.

## Content Warning

**This software loads NSFW content.** It monitors ads on adult sites (including Pornhub) as part of scam detection. Browser instances will display explicit content, and screenshots of adult sites are captured for AI analysis. Users must be of legal age in their jurisdiction.

## How It Works

1. **Hunters** crawl ads from search engines, adult sites, and typosquatted domains
2. **Browser automation** follows redirect chains using stealth techniques (Patchright, proxy rotation, fingerprint spoofing)
3. **AI classifier** (ResNet18 ONNX model) analyzes screenshots to detect scam pages
4. **Signal detection** identifies suspicious behaviors (fullscreen requests, keyboard/pointer lock, worker bombs)
5. **Scam decision** requires: classifier confidence ≥ 90% AND at least one weighted signal
6. **Reporting** submits confirmed scams to Google SafeBrowsing, Netcraft, and SmartScreen
7. **Takedown monitoring** tracks when security services flag the URLs
8. **Discord bot** provides management, alerts, and debugging via slash commands

### Hunters

| Hunter | Source | Method |
|--------|--------|--------|
| Search Ad | Syndicated search ad networks | Scrapes iframe ads from search result pages |
| Pornhub Ad | Pornhub ad API | Fetches and follows ad redirect URLs |
| AdSpyGlass | Adult sites using AdSpyGlass | Triggers popunder ads by clicking video players |
| Typosquat | Typosquatted domains | Visits domains from `typosquats.json` and follows redirects |

## Tech Stack

- **Runtime**: Node.js 24 + TypeScript
- **Database**: PostgreSQL
- **Browser**: Patchright (stealth Playwright fork)
- **AI/ML**: ONNX Runtime (model trained with Ultralytics YOLO)
- **Bot**: Discord.js
- **Testing**: Vitest

## Prerequisites

- Node.js 24 with Yarn
- PostgreSQL
- Discord bot token
- Mobile proxy (unlimited data) for hunters + rotating residential proxy for the redirect checker
- Google Web Risk API credentials (for reporting)
- Chromium (installed via Playwright)

## Setup

```bash
git clone https://github.com/j027/redirectChecker.git
cd redirectChecker
corepack enable
yarn install
```

Create `config.json` following the structure in `src/config.ts`, and a `.env` with Postgres/API credentials.

```bash
yarn init-db:dev      # Initialize database
yarn deploy:dev       # Register Discord commands
yarn start:dev        # Start in dev mode
```

For production: `yarn build && yarn start`

## Discord Commands

| Command | Description |
|---------|-------------|
| `/add <url> <type>` | Add a redirect to monitor |
| `/remove <id>` | Remove a redirect |
| `/status` | View all redirects and their current status |
| `/takedown_status [count]` | View recent takedowns and timing |
| `/report <url>` | Manually report a URL |
| `/hunterlogs` | View hunter event logs (filterable by hunter/event type) |
| `/ads` | Browse detected ads with scam/clean filtering |
| `/redirectlogs` | View redirect checker logs (filterable by event/source) |

## Testing

```bash
yarn test
```

Some tests require a display for non-headless browser instances.

## License

See [LICENSE](LICENSE).

## Disclaimer

This tool is for cybersecurity research to combat online scams. Users must comply with applicable laws. Some takedown status checks use undocumented APIs where no public alternatives exist.

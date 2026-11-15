# TrackSub

Ad attribution and subscriber analytics for Telegram and MAX channels: which ad actually brings subscribers who stay.

> Russian documentation: [docs/README.ru.md](docs/README.ru.md)

## Problem

Messenger channels are a black box for advertisers. A platform reports "+1 subscriber" but not which ad, campaign or creative produced it, so budgets are judged by clicks instead of retained subscribers.

## Solution

TrackSub puts a tracking redirect in front of the channel, collects platform webhooks, and joins the two in a separate attribution layer. Every attribution is stored with its type (exact or probabilistic), confidence and candidate list, and can be recomputed from raw events at any time. Confirmed conversions are sent back to the ad platform.

The system does not present a guess as a fact:

- **Telegram** - exact attribution. Each click gets its own one-time invite link from a pool, and the join event carries that link.
- **MAX** - the subscribe event has no source. Attribution is exact only through a bot deep link; otherwise it is probabilistic and labelled as such in the UI.

## Features

- Accounts, sessions stored in the database, CSRF protection, login rate limiting
- Workspaces with timezone, currency, attribution window, members and plan limits
- Tracking links (source / campaign / creative / UTM) with a lightweight redirect at `/c/:slug`, bot filtering and click deduplication
- Webhook ingestion for both platforms: raw event store, idempotency keys, retries
- Attribution engine: versioned, deterministic, re-runnable over raw data
- Analytics: clicks, subscribes, unsubscribes, CR, cost per subscriber, D1/D7/D30 retention, cost per *retained* subscriber
- Conversion dispatcher: queue, backoff retries, delivery statuses, Yandex Metrika offline conversions by `yclid`
- Admin area: failed events, stuck conversions, one-click replay
- Demo mode with clearly labelled sample data
- Content module: collecting short-video references, relevance scoring, publication tracking, Telegram digests
- Operations: Docker, `/health`, structured logs, backup and restore tools

## Tech stack

- **Node.js 22.5+**, plain JavaScript, **zero runtime dependencies**
- `node:sqlite` for storage (PostgreSQL migration included in `migrations/postgres`)
- `node:test` for tests
- Server-rendered HTML, hand-written HTTP layer
- Docker / Docker Compose, Caddy as reverse proxy

## Architecture

```
Tracking (/c/:slug, click_id, UTM)
        |
Platform adapters: TelegramAdapter, MaxAdapter   <- the only code that knows about platforms
        |
Raw Event Store (append-only, never deleted)
        |
Normalizer -> domain events (subscribe / unsubscribe / bot start)
        |
Attribution Engine (pure function, versioned, recomputable)
        |
Analytics Core (cohorts, retention, CPS)
        |
Conversion Dispatcher -> YandexMetrika, YandexDirect
```

Two interfaces keep the core platform-neutral: `PlatformAdapter` (input) and `ConversionProvider` (output). Design notes: [docs/architecture.md](docs/architecture.md), formal attribution spec: [docs/attribution.md](docs/attribution.md).

## Run locally

```bash
cp .env.example .env
npm start        # http://localhost:3000
npm test         # 130 tests, node:test
```

No `npm install` is needed. Without platform tokens the adapters run in **mock** mode: the queue works, nothing is sent out, and the UI says so.

Useful tools: `npm run replay` (re-run the pipeline over raw events), `npm run backup`, `npm run restore`.

## Status and limitations

- The service runs in production for the author's own projects.
- Real integrations need a Telegram bot token, a MAX bot token (available to Russian legal entities only), an HTTPS domain and a Yandex OAuth token. None of these are in the repository.
- Deployment scripts and server configuration are intentionally not included.
- Billing is manual (plans are activated by an administrator).

## How this was built

I designed the product, the data model and the attribution rules, and I run the service. The code was written together with AI coding agents (Claude Code, Codex) under my specifications and review; the decision records in `docs/gate-*-report.md` show how each stage was accepted.

# PebblePilot

Wrist remote for [Cursor](https://cursor.com) agents on a **Pebble Time 2** (Emery / Rebble).

```
Pebble Time 2  →  phone (PebbleKit JS)  →  LAN / Tailscale  →  home daemon  →  Cursor SDK
```

Start preset tasks, watch status, stop runs, and approve / continue — all from the watch. A small Node daemon on your computer owns Cursor orchestration; the watch stays a thin client.

## Features

- **Local-first repos** — uses checkouts under `PEBBLEPILOT_REPOS_ROOT` (e.g. `/home/hunt/github/<repo>`); only clones if a folder is missing
- **Repo screen** — branch, dirty/clean status, **last commit message**, last agent/task
- **Push policy** — No push / Ask before push / Commit+push (injected into the agent prompt)
- **Voice commands** — Alloy `Dictation` mic API on Pebble Time 2 for freeform tasks
- **Preset prompts** — quick starts when you don’t want to speak
- **Stop / Approve / Continue** without picking up the phone
- **Clay settings** on the phone for daemon URL, shared token, and Cursor API key
- **Local agents** via [`@cursor/sdk`](https://www.npmjs.com/package/@cursor/sdk) in each repo’s working directory

## Layout

```
pebblepilot/
├── .env.example          # copy → .env (secrets; gitignored)
├── config.example.json   # copy → config.json (projects; gitignored)
├── daemon/               # HTTP + WebSocket bridge
├── pebble/               # Alloy watchapp (Time 2 / Emery)
└── scripts/              # sync-watch-config, smoke tests
```

## Prerequisites

- Node.js **≥ 22.13**
- Cursor API key from [Cursor Dashboard → Integrations](https://cursor.com/dashboard/integrations)
- [Pebble SDK](https://developer.rebble.io/) / `pebble` CLI for building the watch app
- Phone on the same LAN (or Tailscale) as the machine running the daemon

Do **not** expose the daemon to the public internet.

## Quick start

### 1. Configure

```bash
cp .env.example .env
cp config.example.json config.json
```

Edit **`.env`** (never commit this file):

| Variable | Purpose |
|----------|---------|
| `CURSOR_API_KEY` | Cursor API key (optional if you paste it in Clay on the phone) |
| `PEBBLEPILOT_TOKEN` | Long random shared secret; must match Clay “Daemon token” |
| `PEBBLEPILOT_HOST` | Bind address (`0.0.0.0` for LAN, or a Tailscale IP) |
| `PEBBLEPILOT_PORT` | Default `8787` |
| `PEBBLEPILOT_LAN_HOST` | IP your phone uses to reach this machine |
| `PEBBLEPILOT_GITHUB_USER` | GitHub user/org whose repos appear on the watch |
| `PEBBLEPILOT_REPOS_ROOT` | Directory for local clones (default `~/github`) |
| `GITHUB_TOKEN` | PAT for private repos + higher API rate limits |

Optional **`config.json`** can still pin specific projects / custom presets; otherwise repos are discovered from GitHub + local clones.

### 2. Run the daemon

```bash
npm install
npm run dev
```

Default listen URL: `http://0.0.0.0:8787` when set in `.env` (use your LAN IP from the phone).

#### Smoke test

```bash
TOKEN=$(grep '^PEBBLEPILOT_TOKEN=' .env | cut -d= -f2-)

curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/projects | jq

curl -s -X POST http://127.0.0.1:8787/agents \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"projectId":"pebblepilot","prompt":"Summarize this repository in 3 bullets."}' | jq
```

### 3. Build & install the watch app

```bash
npm run sync-watch
cd pebble
pebble build
pebble install --phone <phone-ip>
```

### 4. Phone settings (Clay)

On the phone: Pebble app → **PebblePilot** → settings gear:

- **Cursor API key** — sent to the daemon (`POST /settings`) so you don’t have to export it on the host
- **Daemon URL** — e.g. `http://192.168.1.10:8787` (same host as `PEBBLEPILOT_LAN_HOST`)
- **Daemon token** — same value as `PEBBLEPILOT_TOKEN`

## Watch UI

Classic Pebble `MenuLayer` pattern (section headers, title/subtitle rows, inverted selection).

| Button | Action |
|--------|--------|
| Up / Down | Move highlight |
| Select | Open row / run action |
| Back | Previous screen |

- **Home** — Agents + Controls (`Repos`, `Refresh`)
- **Repos** — Local checkouts first (plus optional remote-only GitHub repos)
- **Repo** — Git status + last commit · push policy · **Voice** · Presets · last agent
- **Agent** — Status + Actions (`Stop`, `Approve / Continue`, full message)

Enable **Settings → Speech Recognition** in the Pebble phone app before using Voice command.

## Daemon API

All routes except `/health` require `Authorization: Bearer <token>` (or `?token=` for WebSocket).

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Liveness |
| `GET` | `/projects` | GitHub/local repos (+ last agent fields) |
| `POST` | `/projects/refresh` | Force re-list from GitHub |
| `GET` | `/agents` | Session list |
| `GET` | `/agents/:id` | Session detail |
| `POST` | `/agents` | `{ projectId, prompt }` start agent |
| `POST` | `/agents/:id/stop` | Cancel current run |
| `POST` | `/agents/:id/message` | `{ text }` follow-up |
| `POST` | `/agents/:id/approve` | `{ choice }` continue / reject |
| `POST` | `/settings` | Phone-synced Cursor API key |
| `GET` | `/pebble/agents` | Compact watch payloads |
| `GET` | `/pebble/agents/:id` | Compact detail |
| `WS` | `/ws?token=...` | Live agent events |

## Networking

Prefer Tailscale or a trusted LAN:

```bash
# .env
PEBBLEPILOT_HOST=0.0.0.0          # or your Tailscale IP
PEBBLEPILOT_LAN_HOST=100.x.y.z    # what the phone dials
PEBBLEPILOT_TOKEN=<long-random>
```

Never bind to `0.0.0.0` on an untrusted network without a strong token and a firewall.

## Design choices

- **Cursor TypeScript SDK** — local agents per project `cwd`; start / stream / cancel / follow-up
- **Dumb watch, smart daemon** — Pebble renders compact JSON and posts actions
- **Preset prompts on-watch** — freeform text belongs on phone / Index 01 later
- **Agent-agnostic API shape** — `/agents` can later front other backends without rewriting the UI

## Security

- `.env`, `config.json`, and generated `pebble/src/embeddedjs/config.js` are **gitignored**
- Commit only `.env.example` and `config.example.json` (placeholders)
- Rotate `PEBBLEPILOT_TOKEN` if it was ever shared or committed

## What's next

- Index 01 → text → `POST /agents` voice pipeline
- Real approval gating via Cursor hooks (`beforeShellExecution` / `preToolUse`)
- Desktop / phone companion for freeform task entry
- Multi-backend agent gateway

## License

Private / unpublished unless you add a license file.

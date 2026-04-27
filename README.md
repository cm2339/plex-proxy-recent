# 🎬 Plex Recently Added

A lightweight proxy that displays your Plex recently added media in [Homepage](https://gethomepage.dev) as a poster card iframe widget, split by library section. Optionally shows an On Deck row, click-through links to Plex Web, and a NEW badge on recently added posters.

## Features

- Poster art with titles and subtitles
- Separate row per Plex library (Movies, TV, Anime, Music, etc.)
- **On Deck row** — shows in-progress media at the top (optional, off by default)
- **Click-through to Plex** — clicking a poster opens that item directly in Plex Web (optional, off by default)
- **NEW badge** — gold pill overlay on posters added within a configurable time window (optional, 48h by default)
- Configurable per-library filtering via section IDs
- `/health` endpoint for Docker and Homepage liveness checks
- `/ui` endpoint to preview the widget directly in a browser
- Secure by default — runs as non-root, read-only filesystem, rate limited

## Preview

Visit the `/ui` endpoint directly in your browser to preview the widget at any time:

```
http://YOUR_HOST_IP:3051/ui
```

This is the same page Homepage embeds as an iframe — useful for checking the layout, verifying posters load, and confirming section filtering before adding it to your dashboard.

## Usage

### 1. Find your Plex section IDs

Each Plex library has a numeric section ID. To find yours, temporarily add `DEBUG_SECRET` to your environment (see [Debug Endpoints](#debug-endpoints) below) and visit:

```
http://YOUR_HOST_IP:3051/debug-sections?secret=YOUR_SECRET
```

This returns a JSON list of all your libraries with their IDs, titles, and types. Once you have the IDs you want, add them to `SECTIONS` and remove or comment out `DEBUG_SECRET`.

### 2. docker-compose.yml

```yaml
services:
  plex-proxy:
    image: cm2339/plex-proxy-recent:latest
    container_name: plex-proxy
    restart: unless-stopped
    environment:
      - PLEX_URL=http://YOUR_PLEX_IP:32400
      - PLEX_TOKEN=YOUR_PLEX_TOKEN
      - LIMIT=10
      - SECTIONS=1,2,3             # comma-separated section IDs
      #- PLEX_CLICKTHROUGH=true    # optional: clicking a poster opens it in Plex Web
      #- SHOW_ON_DECK=true         # optional: show an ▶️ On Deck row above recently added
      #- NEW_BADGE_HOURS=48        # optional: gold NEW badge on recent posters (0 to disable)
      #- DEBUG_SECRET=             # optional: enables debug endpoints when set
    ports:
      - "3051:3001"
    networks:
      - homepage_net
    read_only: true
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add:
      - NET_BIND_SERVICE
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://localhost:3001/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s

networks:
  homepage_net:
    external: true
    name: homepage_default    # match your Homepage network name
```

### 3. Homepage services.yaml

```yaml
- Media:
    - Plex Recently Added:
        icon: plex.png
        href: http://YOUR_PLEX_IP:32400/web
        description: Latest movies, shows & music
        widget:
          type: iframe
          src: http://YOUR_HOST_IP:3051/ui
          classes: h-96
          referrerPolicy: same-origin
          allowFullscreen: false
```

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PLEX_URL` | ✅ | — | Plex server URL including port |
| `PLEX_TOKEN` | ✅ | — | Your X-Plex-Token |
| `LIMIT` | ❌ | `10` | Max items shown per section |
| `SECTIONS` | ❌ | all | Comma-separated library section IDs to include |
| `PORT` | ❌ | `3001` | Internal port the proxy listens on |
| `PLEX_CLICKTHROUGH` | ❌ | `false` | Set to `true` to make posters link directly to that item in Plex Web |
| `SHOW_ON_DECK` | ❌ | `false` | Set to `true` to show an ▶️ On Deck row above recently added sections |
| `NEW_BADGE_HOURS` | ❌ | `48` | Hours after which the NEW badge disappears. Set to `0` to disable entirely |
| `DEBUG_SECRET` | ❌ | disabled | Enables debug endpoints when set — remove after initial setup |
| REFRESH_INTERVAL | ❌ | 0 | Auto-refresh interval in seconds. Set to e.g. 300 for every 5 minutes. 0 disables. |

## Debug Endpoints

Debug endpoints are **disabled by default**. They are only active when `DEBUG_SECRET` is set, and every request must include the secret as a query parameter. Remove or comment out `DEBUG_SECRET` once your setup is complete.

### `/debug-sections`

Returns a JSON list of all your Plex libraries with their section IDs. Use this to find the IDs for the `SECTIONS` variable.

```
http://YOUR_HOST_IP:3051/debug-sections?secret=YOUR_SECRET
```

Example response:
```json
[
  { "id": "1", "title": "Movies", "type": "movie" },
  { "id": "2", "title": "TV Shows", "type": "show" },
  { "id": "3", "title": "Music", "type": "artist" }
]
```

### `/debug`

Returns raw recently added metadata from Plex. Useful for inspecting what fields are available or troubleshooting missing posters and titles.

```
http://YOUR_HOST_IP:3051/debug?secret=YOUR_SECRET
```

## Finding your Plex Token

Open Plex Web → any media item → ⋮ → **Get Info** → **View XML** → copy the `X-Plex-Token` value from the URL.

## Network

The container must share a Docker network with Homepage. Check your network name with:

```bash
docker network ls | grep homepage
```

If Homepage is running under a different network name, update the `name:` field under `networks` in the compose file to match.
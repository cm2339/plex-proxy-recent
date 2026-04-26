# 🎬 Plex Recently Added

A lightweight proxy that displays your Plex recently added media in [Homepage](https://gethomepage.dev) as a poster card iframe widget, split by library section.

## Features

- Poster art with titles and subtitles
- Separate row per Plex library (Movies, TV, Anime, Music, etc.)
- Configurable per-library filtering via section IDs
- Secure by default — runs as non-root, read-only filesystem

## Preview

<!-- optionally upload a screenshot to the repo and link it here -->
<!-- ![Preview](https://raw.githubusercontent.com/yourname/yourrepo/main/preview.png) -->

## Usage

### 1. Find your Plex section IDs

Temporarily add `DEBUG_SECRET` to your environment and visit: http://YOUR_HOST_IP:3051/debug-sections?secret=YOUR_SECRET

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
      - SECTIONS=1,2,3        # comma-separated section IDs
      #- DEBUG_SECRET=         # optional, enables debug endpoints
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
| `DEBUG_SECRET` | ❌ | disabled | Enables `/debug` and `/debug-sections` endpoints when set |

## Finding your Plex Token

Open Plex Web → any media item → ⋮ → Get Info → View XML → copy `X-Plex-Token` from the URL.

## Network

The container must share a Docker network with Homepage. Check your network name with:
```bash
docker network ls | grep homepage
```

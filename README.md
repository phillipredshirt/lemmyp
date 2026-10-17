# lemmyp

Full-screen Lemmy media slideshow — think **redditp** for the fediverse.

Browse any Lemmy community as an auto-advancing, keyboard-driven slideshow
of images and videos. Dark theme, minimal chrome, works on desktop and mobile.

## Quick start

```bash
# Docker
docker compose up -d --build
# then open http://localhost:8080

# Or bare metal
npm install
npm start
```

## Usage

| URL | What you get |
|---|---|
| `/` | Instance + community selector |
| `/c/memes` | Slideshow for `c/memes` on `lemmy.world` |
| `/c/memes?instance=sh.itjust.works&sort=New` | Same, different instance/sort |
| `/c/aww?sort=Hot` | Aww on default instance, hot sort |

### Keyboard shortcuts

| Key | Action |
|---|---|
| `←` `→` / `Space` / `PgUp` `PgDown` | Previous / next slide |
| `A` | Toggle auto-advance (5 s) |
| `F` | Toggle fullscreen |
| `M` | Toggle sound (videos) |
| `T` | Toggle title bar |
| `P` | Toggle control bar |
| `N` | Toggle NSFW filter |
| `O` | Open current post (comments) in new tab |
| `C` | Copy shareable URL to clipboard |
| `Home` / `End` | Jump to first / last loaded slide |
| `Esc` | Back to selector |

### Touch
Swipe left/right on mobile to navigate.

## Instances

Hardcoded list of well-known Lemmy instances. Default is `lemmy.world`.
The list includes `fedinsfw.app` for NSFW browsing.

You can also type any Lemmy instance hostname into the selector — the
server validates it and proxies the request.

## Configuration

| Env var | Default | Description |
|---|---|---|
| `PORT` | `8080` | Listen port |

Everything else (default instance, page size, NSFW default) is configured
in `public/app.js` constants at the top of the file.

## How it works

1. The Express server proxies `GET /api/:instance/*` → `https://:instance/api/v3/*`
   with a 30-second in-memory cache.
2. The frontend fetches posts (25 per page), filters to media (images + videos
   + link cards), and renders a full-screen slideshow.
3. When you're 4 slides from the end, the next page is prefetched silently.
4. The URL is shareable: `/c/memes?instance=lemmy.world&sort=Hot`.

## NSFW

NSFW content is **shown by default**. Toggle the `N` key or the NSFW button
to filter it out. This is intentional — the app is designed for unfiltered
browsing, and instances like `fedinsfw.app` are first-class.

## Project structure

```
lemmyp/
├── server.js          # Express proxy + static server
├── public/
│   ├── index.html     # SPA shell
│   ├── style.css      # Dark theme
│   └── app.js         # All frontend logic
├── Dockerfile         # Multi-stage, node:20-alpine
├── docker-compose.yml
├── .dockerignore
└── package.json
```

## Roadmap

- [ ] Browse user posts (`/u/username`)
- [ ] PWA / installable
- [ ] Bookmark / save slides
- [ ] Zoom & pan for images
- [ ] Configurable auto-advance interval
- [ ] Instance discovery via Lemmy's community search API

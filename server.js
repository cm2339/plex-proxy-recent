const http = require("http");
const https = require("https");

const PORT = process.env.PORT || 3001;
const PLEX_URL = process.env.PLEX_URL;
const PLEX_TOKEN = process.env.PLEX_TOKEN;
const LIMIT = parseInt(process.env.LIMIT || "10", 10);
const SECTIONS = process.env.SECTIONS
  ? process.env.SECTIONS.split(",").map(s => s.trim()).filter(Boolean)
  : null;

// Feature flags
const PLEX_CLICKTHROUGH  = (process.env.PLEX_CLICKTHROUGH  || "false").toLowerCase() === "true";
const SHOW_ON_DECK       = (process.env.SHOW_ON_DECK       || "false").toLowerCase() === "true";
const NEW_BADGE_HOURS    = parseInt(process.env.NEW_BADGE_HOURS   || "48", 10);
const REFRESH_INTERVAL   = parseInt(process.env.REFRESH_INTERVAL  || "0",  10); // seconds, 0 = disabled
const SHOW_PROGRESS_BAR  = (process.env.SHOW_PROGRESS_BAR  || "true").toLowerCase()  === "true";

// Optional secret for debug endpoints. If set, requests must include ?secret=VALUE
const DEBUG_SECRET = process.env.DEBUG_SECRET || null;

if (!PLEX_URL || !PLEX_TOKEN) {
  console.error("ERROR: PLEX_URL and PLEX_TOKEN environment variables are required.");
  process.exit(1);
}

if (!DEBUG_SECRET) {
  console.warn("WARN: DEBUG_SECRET not set — debug endpoints are disabled.");
}

// Cache the Plex machine identifier (needed for click-through deep links)
let plexMachineId = null;

async function getPlexMachineId() {
  if (plexMachineId) return plexMachineId;
  try {
    const json = await fetchJSON(`${PLEX_URL}/?X-Plex-Token=${PLEX_TOKEN}`);
    plexMachineId = json?.MediaContainer?.machineIdentifier || null;
  } catch (err) {
    console.warn("WARN: Could not fetch Plex machine identifier:", err.message);
  }
  return plexMachineId;
}

// ─── Rate limiting ────────────────────────────────────────────────────────────

const rateLimitMap = new Map();
const RATE_LIMIT  = 200;
const RATE_WINDOW = 60_000;

function isRateLimited(ip) {
  const now = Date.now();
  let entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_WINDOW };
    rateLimitMap.set(ip, entry);
  }
  entry.count++;
  return entry.count > RATE_LIMIT;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(ip);
  }
}, 300_000);

// ─── Plex fetch ───────────────────────────────────────────────────────────────

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const options = { headers: { "Accept": "application/json", "X-Plex-Token": PLEX_TOKEN } };

    lib.get(url, options, (res) => {
      let data = "";
      let size = 0;

      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > 10 * 1024 * 1024) {
          res.destroy();
          reject(new Error("Plex response too large"));
          return;
        }
        data += chunk;
      });

      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${e.message}\nBody: ${data.slice(0, 200)}`)); }
      });
    }).on("error", reject);
  });
}

function proxyImage(plexPath, res) {
  if (!/^\/library\/[a-zA-Z0-9/._-]+$/.test(plexPath)) {
    res.writeHead(400);
    res.end();
    return;
  }

  const url = `${PLEX_URL}${plexPath}?X-Plex-Token=${PLEX_TOKEN}`;
  const lib = url.startsWith("https") ? https : http;

  lib.get(url, { headers: { "X-Plex-Token": PLEX_TOKEN } }, (plexRes) => {
    const ct = plexRes.headers["content-type"] || "";
    if (!ct.startsWith("image/")) {
      res.writeHead(400);
      res.end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": ct,
      "Cache-Control": "public, max-age=3600",
      "Content-Security-Policy": "default-src 'none'",
    });
    plexRes.pipe(res);
  }).on("error", () => { res.writeHead(502); res.end(); });
}

// ─── Data mapping ─────────────────────────────────────────────────────────────

function mapItem(item, sectionLabel) {
  const type = item.type;
  let title, subtitle, thumb, ratingKey;

  ratingKey = item.ratingKey || null;

  if (type === "movie") {
    title    = item.title;
    subtitle = item.year ? String(item.year) : "";
    thumb    = item.thumb;
  } else if (type === "episode") {
    title    = item.grandparentTitle || item.parentTitle || item.title;
    const s  = item.parentIndex != null ? "S" + String(item.parentIndex).padStart(2, "0") : "";
    const e  = item.index       != null ? "E" + String(item.index).padStart(2, "0")       : "";
    subtitle = [s + e, item.title].filter(Boolean).join(" - ");
    thumb    = item.grandparentThumb || item.parentThumb || item.thumb;
    ratingKey = item.ratingKey || null;
  } else if (type === "season") {
    title    = item.parentTitle || item.title;
    subtitle = item.title;
    thumb    = item.parentThumb || item.thumb;
  } else if (type === "album") {
    title    = item.parentTitle || item.title;
    subtitle = item.title;
    thumb    = item.thumb;
  } else if (type === "artist") {
    title    = item.title;
    subtitle = "";
    thumb    = item.thumb;
  } else {
    title    = item.title;
    subtitle = item.year ? String(item.year) : (type || "");
    thumb    = item.thumb;
  }

  // Progress: viewOffset and duration are in milliseconds
  const viewOffset = item.viewOffset || 0;
  const duration   = item.duration   || 0;
  const progress   = (duration > 0 && viewOffset > 0)
    ? Math.min(100, Math.round((viewOffset / duration) * 100))
    : 0;

  return {
    title,
    subtitle,
    type,
    sectionLabel,
    thumbPath:  thumb     || null,
    ratingKey:  ratingKey || null,
    addedAt:    item.addedAt || 0,
    progress,   // 0-100, only meaningful for On Deck items
  };
}

function emojiForSection(label) {
  const l = label.toLowerCase();
  if (l.includes("anime"))                                              return "⛩️";
  if (l.includes("cartoon"))                                            return "🎨";
  if (l.includes("sport"))                                              return "⚽";
  if (l.includes("music"))                                              return "🎵";
  if (l.includes("movie") || l.includes("film"))                       return "🎬";
  if (l.includes("tv") || l.includes("show") || l.includes("series"))  return "📺";
  if (l.includes("photo"))                                              return "📷";
  return "🎞️";
}

async function getSectionInfo() {
  const json = await fetchJSON(`${PLEX_URL}/library/sections?X-Plex-Token=${PLEX_TOKEN}`);
  const dirs = json?.MediaContainer?.Directory || [];
  const map  = {};
  for (const d of dirs) map[String(d.key)] = { title: d.title, type: d.type };
  return map;
}

async function getRecentlyAdded() {
  const sectionInfo = await getSectionInfo();
  const sectionIds  = SECTIONS || Object.keys(sectionInfo);

  const results = await Promise.all(
    sectionIds.map(async (id) => {
      const label = sectionInfo[id]?.title || `Section ${id}`;
      try {
        const json = await fetchJSON(
          `${PLEX_URL}/library/sections/${id}/recentlyAdded?X-Plex-Token=${PLEX_TOKEN}`
        );
        return { label, items: json?.MediaContainer?.Metadata || [] };
      } catch (err) {
        console.error(`Section ${id} (${label}) error:`, err.message);
        return { label, items: [] };
      }
    })
  );

  const sections = new Map();

  for (const { label, items } of results) {
    if (!items.length) continue;
    const seen   = new Set();
    const mapped = [];

    for (const raw of items) {
      const item      = mapItem(raw, label);
      const dedupeKey = raw.type === "episode" || raw.type === "season"
        ? `tv:${item.title}`
        : `${raw.type}:${item.title}`;

      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey);
        mapped.push(item);
      }
      if (mapped.length >= LIMIT) break;
    }

    if (mapped.length) sections.set(label, mapped);
  }

  return sections;
}

async function getOnDeck() {
  try {
    const json  = await fetchJSON(`${PLEX_URL}/library/onDeck?X-Plex-Token=${PLEX_TOKEN}`);
    const items = json?.MediaContainer?.Metadata || [];
    const seen  = new Set();
    const mapped = [];

    for (const raw of items) {
      const item      = mapItem(raw, "On Deck");
      const dedupeKey = raw.type === "episode"
        ? `tv:${item.title}`
        : `${raw.type}:${item.title}`;

      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey);
        mapped.push(item);
      }
      if (mapped.length >= LIMIT) break;
    }

    return mapped;
  } catch (err) {
    console.error("On Deck error:", err.message);
    return [];
  }
}

// ─── HTML renderer ────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildPlexDeepLink(ratingKey, machineId) {
  if (!ratingKey || !machineId) return null;
  return `${PLEX_URL}/web/index.html#!/server/${machineId}/details?key=${encodeURIComponent(`/library/metadata/${ratingKey}`)}`;
}

function isNew(addedAt) {
  if (!addedAt || NEW_BADGE_HOURS <= 0) return false;
  const ageMs = Date.now() - (addedAt * 1000);
  return ageMs < NEW_BADGE_HOURS * 60 * 60 * 1000;
}

function renderCard(item, proxyBase, machineId, showBadge, showProgress) {
  const imgSrc   = item.thumbPath
    ? `${proxyBase}/thumb?path=${encodeURIComponent(item.thumbPath)}`
    : `${proxyBase}/placeholder`;

  const deepLink = PLEX_CLICKTHROUGH ? buildPlexDeepLink(item.ratingKey, machineId) : null;

  const newBadge = (showBadge && isNew(item.addedAt))
    ? `<span class="badge-new">NEW</span>`
    : "";

  const progressBar = (showProgress && SHOW_PROGRESS_BAR && item.progress > 0)
    ? `<div class="progress-track"><div class="progress-fill" style="width:${item.progress}%"></div></div>`
    : "";

  const inner = `
    <div class="poster-wrap">
      <img src="${escapeHtml(imgSrc)}" alt="" loading="lazy" onerror="this.src='${proxyBase}/placeholder'">
      ${newBadge}
      ${progressBar}
    </div>
    <div class="info">
      <div class="title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
      ${item.subtitle ? `<div class="subtitle" title="${escapeHtml(item.subtitle)}">${escapeHtml(item.subtitle)}</div>` : ""}
    </div>`;

  if (deepLink) {
    return `
<a class="card" href="${escapeHtml(deepLink)}" target="_blank" rel="noopener noreferrer" title="Open in Plex: ${escapeHtml(item.title)}">
  ${inner}
</a>`;
  }

  return `
<div class="card">
  ${inner}
</div>`;
}

function renderSection(label, items, proxyBase, machineId) {
  if (!items.length) return "";
  const emoji       = label === "On Deck" ? "▶️" : emojiForSection(label);
  const showBadge   = label !== "On Deck"; // NEW badge only on recently added
  const showProgress = label === "On Deck"; // progress bar only on On Deck

  return `
<section>
  <h2>${emoji} ${escapeHtml(label)}</h2>
  <div class="grid">
    ${items.map(i => renderCard(i, proxyBase, machineId, showBadge, showProgress)).join("")}
  </div>
</section>`;
}

function buildHTML(recentSections, onDeckItems, proxyBase, machineId) {
  const clickthroughStyle = PLEX_CLICKTHROUGH ? `
    .card { cursor: pointer; text-decoration: none; }
    .card:hover img { opacity: 0.8; transform: scale(1.03); }
    .card:hover .title { color: #e8b04b; }
  ` : "";

  const refreshMeta = (REFRESH_INTERVAL > 0)
    ? `<meta http-equiv="refresh" content="${REFRESH_INTERVAL}">`
    : "";

  const onDeckHTML = (SHOW_ON_DECK && onDeckItems.length)
    ? renderSection("On Deck", onDeckItems, proxyBase, machineId)
    : "";

  const recentHTML = [...recentSections.entries()]
    .map(([label, items]) => renderSection(label, items, proxyBase, machineId))
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; script-src 'none'; connect-src 'none';">
  ${refreshMeta}
  <title>Recently Added</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: transparent;
      color: #e5e7eb;
      font-family: ui-sans-serif, system-ui, sans-serif;
      padding: 12px 14px;
      font-size: 13px;
    }
    section { margin-bottom: 18px; }
    section:last-child { margin-bottom: 0; }
    h2 {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #9ca3af;
      margin-bottom: 10px;
    }
    .grid {
      display: flex;
      gap: 10px;
      overflow-x: auto;
      padding-bottom: 4px;
      scrollbar-width: thin;
      scrollbar-color: rgba(255,255,255,0.15) transparent;
    }
    .card {
      flex: 0 0 auto;
      width: 80px;
      cursor: default;
      display: block;
    }
    .poster-wrap {
      position: relative;
      width: 80px;
      height: 120px;
    }
    .card img {
      width: 80px;
      height: 120px;
      object-fit: cover;
      border-radius: 6px;
      background: #1f2937;
      display: block;
      transition: opacity 0.2s ease, transform 0.2s ease;
    }
    .badge-new {
      position: absolute;
      top: 5px;
      left: 5px;
      background: #e8b04b;
      color: #000;
      font-size: 8px;
      font-weight: 700;
      letter-spacing: 0.06em;
      padding: 2px 5px;
      border-radius: 3px;
      line-height: 1.4;
      pointer-events: none;
    }
    .progress-track {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: rgba(0,0,0,0.5);
      border-radius: 0 0 6px 6px;
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      background: #e8b04b;
      border-radius: 0 0 0 6px;
      min-width: 2px;
    }
    .info { margin-top: 5px; }
    .title {
      font-size: 11px;
      font-weight: 500;
      color: #f3f4f6;
      line-height: 1.3;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      transition: color 0.2s ease;
    }
    .subtitle {
      font-size: 10px;
      color: #6b7280;
      margin-top: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    ${clickthroughStyle}
  </style>
</head>
<body>
  ${onDeckHTML}
  ${recentHTML}
</body>
</html>`;
}

const PLACEHOLDER = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

// ─── Security headers ─────────────────────────────────────────────────────────

function setSecurityHeaders(res, extra = {}) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "no-referrer");
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
}

function setUiHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  if (req.method !== "GET") {
    setSecurityHeaders(res);
    res.writeHead(405);
    res.end();
    return;
  }

  const ip = req.socket.remoteAddress || "unknown";
  if (isRateLimited(ip)) {
    setSecurityHeaders(res);
    res.writeHead(429);
    res.end(JSON.stringify({ error: "Too many requests" }));
    return;
  }

  const urlObj = new URL(req.url, `http://localhost:${PORT}`);
  const path   = urlObj.pathname;

  // ── /ui ──────────────────────────────────────────────────────

  if (path === "/ui") {
    const proxyBase = `http://${req.headers.host}`;
    try {
      const [recentSections, onDeckItems, machineId] = await Promise.all([
        getRecentlyAdded(),
        SHOW_ON_DECK ? getOnDeck() : Promise.resolve([]),
        PLEX_CLICKTHROUGH ? getPlexMachineId() : Promise.resolve(null),
      ]);

      const html = buildHTML(recentSections, onDeckItems, proxyBase, machineId);
      setUiHeaders(res);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (err) {
      console.error("/ui error:", err.message);
      setSecurityHeaders(res);
      res.writeHead(500, { "Content-Type": "text/html" });
      res.end("<p>Internal error. Check container logs.</p>");
    }
    return;
  }

  // ── /thumb ───────────────────────────────────────────────────

  if (path === "/thumb") {
    const plexPath = urlObj.searchParams.get("path");
    if (!plexPath) { res.writeHead(400); res.end(); return; }
    setSecurityHeaders(res);
    proxyImage(plexPath, res);
    return;
  }

  // ── /placeholder ─────────────────────────────────────────────

  if (path === "/placeholder") {
    setSecurityHeaders(res, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
    res.writeHead(200);
    res.end(PLACEHOLDER);
    return;
  }

  // ── Debug endpoints ───────────────────────────────────────────

  if (path === "/debug" || path === "/debug-sections") {
    if (!DEBUG_SECRET) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    const provided = urlObj.searchParams.get("secret");
    if (provided !== DEBUG_SECRET) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    try {
      if (path === "/debug-sections") {
        const json     = await fetchJSON(`${PLEX_URL}/library/sections?X-Plex-Token=${PLEX_TOKEN}`);
        const sections = (json?.MediaContainer?.Directory || []).map(s => ({
          id: s.key, title: s.title, type: s.type,
        }));
        setSecurityHeaders(res);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(sections, null, 2));
      } else {
        const json     = await fetchJSON(`${PLEX_URL}/library/recentlyAdded?X-Plex-Token=${PLEX_TOKEN}&X-Plex-Features=external-media`);
        const metadata = json?.MediaContainer?.Metadata || [];
        setSecurityHeaders(res);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(metadata.map(i => ({
          type: i.type, title: i.title,
          grandparentTitle: i.grandparentTitle || null,
          parentTitle:      i.parentTitle      || null,
        })), null, 2));
      }
    } catch (err) {
      console.error("Debug error:", err.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: "Internal error" }));
    }
    return;
  }

  // ── /health ───────────────────────────────────────────────────

  if (path === "/health") {
    setSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status:  "ok",
      uptime:  Math.floor(process.uptime()),
      plex:    PLEX_URL,
      features: {
        clickthrough:    PLEX_CLICKTHROUGH,
        onDeck:          SHOW_ON_DECK,
        progressBar:     SHOW_PROGRESS_BAR,
        newBadgeHours:   NEW_BADGE_HOURS,
        refreshInterval: REFRESH_INTERVAL,
      },
    }));
    return;
  }

  // ── 404 ──────────────────────────────────────────────────────

  setSecurityHeaders(res);
  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`plex-recently-added proxy running on port ${PORT}`);
  console.log(` -> Plex:            ${PLEX_URL}`);
  console.log(` -> UI:              http://localhost:${PORT}/ui`);
  console.log(` -> Limit:           ${LIMIT} items per section`);
  console.log(` -> Sections:        ${SECTIONS ? SECTIONS.join(", ") : "all"}`);
  console.log(` -> Click-through:   ${PLEX_CLICKTHROUGH ? "enabled" : "disabled"}`);
  console.log(` -> On Deck:         ${SHOW_ON_DECK ? "enabled" : "disabled"}`);
  console.log(` -> Progress bar:    ${SHOW_PROGRESS_BAR ? "enabled" : "disabled"}`);
  console.log(` -> New badge:       ${NEW_BADGE_HOURS > 0 ? `${NEW_BADGE_HOURS}h window` : "disabled"}`);
  console.log(` -> Refresh:         ${REFRESH_INTERVAL > 0 ? `every ${REFRESH_INTERVAL}s` : "disabled"}`);
  console.log(` -> Debug:           ${DEBUG_SECRET ? "enabled (secret required)" : "disabled"}`);
});

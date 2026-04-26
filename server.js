const http = require("http");
const https = require("https");

const PORT = process.env.PORT || 3001;
const PLEX_URL = process.env.PLEX_URL;
const PLEX_TOKEN = process.env.PLEX_TOKEN;
const LIMIT = parseInt(process.env.LIMIT || "10", 10);
const SECTIONS = process.env.SECTIONS
  ? process.env.SECTIONS.split(",").map(s => s.trim()).filter(Boolean)
  : null;
// Optional secret for debug endpoints. If set, requests must include ?secret=VALUE
const DEBUG_SECRET = process.env.DEBUG_SECRET || null;

if (!PLEX_URL || !PLEX_TOKEN) {
  console.error("ERROR: PLEX_URL and PLEX_TOKEN environment variables are required.");
  process.exit(1);
}

// Warn if debug endpoints are enabled without a secret
if (!DEBUG_SECRET) {
  console.warn("WARN: DEBUG_SECRET not set — debug endpoints are disabled.");
}

// ─── Rate limiting ────────────────────────────────────────────────────────────

const rateLimitMap = new Map(); // ip -> { count, resetAt }
const RATE_LIMIT = 30;          // max requests
const RATE_WINDOW = 60_000;     // per 60 seconds

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

// Clean up stale entries every 5 minutes
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
      // Limit response size to 10MB to prevent memory exhaustion
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
  // Validate path looks like a Plex media path before proxying
  if (!/^\/library\/[a-zA-Z0-9/_-]+$/.test(plexPath)) {
    res.writeHead(400);
    res.end();
    return;
  }
  const url = `${PLEX_URL}${plexPath}?X-Plex-Token=${PLEX_TOKEN}`;
  const lib = url.startsWith("https") ? https : http;
  lib.get(url, { headers: { "X-Plex-Token": PLEX_TOKEN } }, (plexRes) => {
    const ct = plexRes.headers["content-type"] || "";
    // Only proxy image content types
    if (!ct.startsWith("image/")) {
      res.writeHead(400);
      res.end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": ct,
      "Cache-Control": "public, max-age=3600",
      // Prevent the image from being used in other contexts
      "Content-Security-Policy": "default-src 'none'",
    });
    plexRes.pipe(res);
  }).on("error", () => { res.writeHead(502); res.end(); });
}

// ─── Data mapping ─────────────────────────────────────────────────────────────

function mapItem(item, sectionLabel) {
  const type = item.type;
  let title, subtitle, thumb;

  if (type === "movie") {
    title = item.title;
    subtitle = item.year ? String(item.year) : "";
    thumb = item.thumb;
  } else if (type === "episode") {
    title = item.grandparentTitle || item.parentTitle || item.title;
    const s = item.parentIndex != null ? "S" + String(item.parentIndex).padStart(2, "0") : "";
    const e = item.index != null ? "E" + String(item.index).padStart(2, "0") : "";
    subtitle = [s + e, item.title].filter(Boolean).join(" - ");
    thumb = item.grandparentThumb || item.parentThumb || item.thumb;
  } else if (type === "season") {
    title = item.parentTitle || item.title;
    subtitle = item.title;
    thumb = item.parentThumb || item.thumb;
  } else if (type === "album") {
    title = item.parentTitle || item.title;
    subtitle = item.title;
    thumb = item.thumb;
  } else if (type === "artist") {
    title = item.title;
    subtitle = "";
    thumb = item.thumb;
  } else {
    title = item.title;
    subtitle = item.year ? String(item.year) : (type || "");
    thumb = item.thumb;
  }

  return {
    title,
    subtitle,
    type,
    sectionLabel,
    thumbPath: thumb || null,
    addedAt: item.addedAt || 0,
  };
}

function emojiForSection(label) {
  const l = label.toLowerCase();
  if (l.includes("anime")) return "\u26E9\uFE0F";
  if (l.includes("cartoon")) return "\uD83C\uDFA8";
  if (l.includes("sport")) return "\u26BD";
  if (l.includes("music")) return "\uD83C\uDFB5";
  if (l.includes("movie") || l.includes("film")) return "\uD83C\uDFAC";
  if (l.includes("tv") || l.includes("show") || l.includes("series")) return "\uD83D\uDCFA";
  if (l.includes("photo")) return "\uD83D\uDCF7";
  return "\uD83C\uDF9E\uFE0F";
}

async function getSectionInfo() {
  const json = await fetchJSON(`${PLEX_URL}/library/sections?X-Plex-Token=${PLEX_TOKEN}`);
  const dirs = json?.MediaContainer?.Directory || [];
  const map = {};
  for (const d of dirs) map[String(d.key)] = { title: d.title, type: d.type };
  return map;
}

async function getRecentlyAdded() {
  const sectionInfo = await getSectionInfo();
  const sectionIds = SECTIONS || Object.keys(sectionInfo);

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
    const seen = new Set();
    const mapped = [];
    for (const raw of items) {
      const item = mapItem(raw, label);
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

// ─── HTML renderer ────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderCard(item, proxyBase) {
  const imgSrc = item.thumbPath
    ? `${proxyBase}/thumb?path=${encodeURIComponent(item.thumbPath)}`
    : `${proxyBase}/placeholder`;
  return `
    <div class="card">
      <img src="${escapeHtml(imgSrc)}" alt="" loading="lazy" onerror="this.src='${proxyBase}/placeholder'">
      <div class="info">
        <div class="title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
        ${item.subtitle ? `<div class="subtitle" title="${escapeHtml(item.subtitle)}">${escapeHtml(item.subtitle)}</div>` : ""}
      </div>
    </div>`;
}

function renderSection(label, items, proxyBase) {
  if (!items.length) return "";
  const emoji = emojiForSection(label);
  return `
    <section>
      <h2>${emoji} ${escapeHtml(label)}</h2>
      <div class="grid">
        ${items.map(i => renderCard(i, proxyBase)).join("")}
      </div>
    </section>`;
}

function buildHTML(sections, proxyBase) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; script-src 'none';">
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
  .card { flex: 0 0 auto; width: 80px; cursor: default; }
  .card img {
    width: 80px;
    height: 120px;
    object-fit: cover;
    border-radius: 6px;
    background: #1f2937;
    display: block;
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
  }
  .subtitle {
    font-size: 10px;
    color: #6b7280;
    margin-top: 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
</head>
<body>
  ${[...sections.entries()].map(([label, items]) => renderSection(label, items, proxyBase)).join("")}
</body>
</html>`;
}

const PLACEHOLDER = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

// ─── Security headers applied to every response ───────────────────────────────

function setSecurityHeaders(res, extra = {}) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "no-referrer");
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
}

// For the /ui iframe endpoint — omits X-Frame-Options so Homepage can embed it
function setUiHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // Only allow GET
  if (req.method !== "GET") {
    setSecurityHeaders(res);
    res.writeHead(405);
    res.end();
    return;
  }

  // Rate limiting by IP
  const ip = req.socket.remoteAddress || "unknown";
  if (isRateLimited(ip)) {
    setSecurityHeaders(res);
    res.writeHead(429);
    res.end(JSON.stringify({ error: "Too many requests" }));
    return;
  }

  const urlObj = new URL(req.url, `http://localhost:${PORT}`);
  const path = urlObj.pathname;

  // ── Public endpoints ──────────────────────────────────────────

  if (path === "/ui") {
    const proxyBase = `http://${req.headers.host}`;
    try {
      const sections = await getRecentlyAdded();
      const html = buildHTML(sections, proxyBase);
      setUiHeaders(res);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (err) {
      console.error("/ui error:", err.message);
      setSecurityHeaders(res);
      res.writeHead(500, { "Content-Type": "text/html" });
      // Don't leak internal error details to the client
      res.end("<p>Internal error. Check container logs.</p>");
    }
    return;
  }

  if (path === "/thumb") {
    const plexPath = urlObj.searchParams.get("path");
    if (!plexPath) { res.writeHead(400); res.end(); return; }
    setSecurityHeaders(res);
    proxyImage(plexPath, res);
    return;
  }

  if (path === "/placeholder") {
    setSecurityHeaders(res, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
    res.writeHead(200);
    res.end(PLACEHOLDER);
    return;
  }

  // ── Debug endpoints — disabled unless DEBUG_SECRET is set ─────

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
        const json = await fetchJSON(`${PLEX_URL}/library/sections?X-Plex-Token=${PLEX_TOKEN}`);
        const sections = (json?.MediaContainer?.Directory || []).map(s => ({
          id: s.key, title: s.title, type: s.type,
        }));
        setSecurityHeaders(res);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(sections, null, 2));
      } else {
        const json = await fetchJSON(`${PLEX_URL}/library/recentlyAdded?X-Plex-Token=${PLEX_TOKEN}&X-Plex-Features=external-media`);
        const metadata = json?.MediaContainer?.Metadata || [];
        setSecurityHeaders(res);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(metadata.map(i => ({
          type: i.type, title: i.title,
          grandparentTitle: i.grandparentTitle || null,
          parentTitle: i.parentTitle || null,
        })), null, 2));
      }
    } catch (err) {
      console.error("Debug error:", err.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: "Internal error" }));
    }
    return;
  }

  // ── 404 for everything else ───────────────────────────────────
  setSecurityHeaders(res);
  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`plex-recently-added proxy running on port ${PORT}`);
  console.log(`  -> Plex:     ${PLEX_URL}`);
  console.log(`  -> UI:       http://localhost:${PORT}/ui`);
  console.log(`  -> Limit:    ${LIMIT} items per section`);
  console.log(`  -> Sections: ${SECTIONS ? SECTIONS.join(", ") : "all"}`);
  console.log(`  -> Debug:    ${DEBUG_SECRET ? "enabled (secret required)" : "disabled"}`);
});

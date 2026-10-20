const express = require("express");
const path = require("path");
const https = require("https");

const app = express();
const PORT = process.env.PORT || 8080;

// ---------------------------------------------------------------------------
// Known instances (also used for SSRF validation)
// ---------------------------------------------------------------------------
const ALLOWED_INSTANCES = new Set([
  "lemmy.world", "sh.itjust.works", "lemmy.ml", "feddit.ex.solar",
  "lemmy.ca", "melroy.dev", "post.lurk.org", "k8s.kevin.dk",
  "federated.lgbtq.love", "lemmy.hue.rain", "saas.pov.lt", "bearblog.dev",
  "midwest.social", "fedinsfw.app", "lemmy.owo", "lemmy.sikaei.nl",
  "lemmy.ch", "lemmyverse.com", "lemmy.cx", "rles.nohost.network",
  "lemmy.nix.su", "lemmy.fartit.dev", "lemmy.broniewal.ch",
  "lemmy.arbrelow.com", "lcode.us", "lemmy.rivers.rocks",
]);

// Allow any .dev, .app, .social, .world, .ml, .dev, .org, .net, .com, etc.
// We validate by trying to resolve the hostname to avoid open-proxy SSRF.
function isAllowedInstance(host) {
  if (ALLOWED_INSTANCES.has(host)) return true;
  // Basic sanity: must look like a hostname, no spaces, no path
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) return false;
  if (host.includes("..")) return false;
  // Block private/internal ranges to prevent SSRF
  if (/^localhost$/i.test(host)) return false;
  if (/^127\./i.test(host)) return false;
  if (/^10\./i.test(host)) return false;
  if (/^192\.168\./i.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./i.test(host)) return false;
  if (/^\[::1\]$/i.test(host)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Simple in-memory cache for API responses
// ---------------------------------------------------------------------------
const cache = new Map();
const CACHE_TTL = 30_000; // 30 s

function cacheGet(key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.time < CACHE_TTL) {
    cache.delete(key);
    cache.set(key, entry); // refresh LRU-ish
    return entry.data;
  }
  cache.delete(key);
  return null;
}

function cacheSet(key, data) {
  cache.set(key, { data, time: Date.now() });
  // Cap cache size
  if (cache.size > 500) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
}

// ---------------------------------------------------------------------------
// HTML fallback: some instances (e.g. fedinsfw.app on PikaPods-style hosting)
// block the /api/* JSON surface but still serve the server-rendered community
// pages, so we scrape those for post/list. API-first: this only runs when the
// JSON call comes back as HTML. The scraped page is page 1 in the instance's
// default sort (Hot); the NSFW gate is bypassed, so every post carries its
// real nsfw flag and the front-end filter still works both ways.
// ---------------------------------------------------------------------------
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
  Accept: "text/html,application/xhtml+xml",
  Cookie: "anoobis2=ok; warned=yes",
};

function fetchHtml(url, redirects = 5) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: BROWSER_HEADERS, timeout: 15_000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(fetchHtml(new URL(res.headers.location, url).toString(), redirects - 1));
      }
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("timeout", () => { req.destroy(); resolve({ status: 0 }); });
    req.on("error", () => resolve({ status: 0 }));
  });
}

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// Parse a server-rendered /c/<community> page into the exact shape the JSON
// API path returns: { posts: [{ post, creator, community, counters }] }.
// Only media posts are kept (direct images, plus video embeds rendered as
// link cards), matching what the front-end can display.
function parseCommunityPage(html, instance, communityName) {
  const posts = [];
  const marks = [];
  // The top-level opener div is `class="h-entry pb-0 post_teaser type_N"`
  // (prefix classes vary), so the unique marker is ` post_teaser type_`
  // — inner elements (post_teaser_body, _title_a, …) never match it.
  let idx = html.indexOf(" post_teaser type_");
  while (idx !== -1) {
    marks.push(idx);
    idx = html.indexOf(" post_teaser type_", idx + 1);
  }
  for (let i = 0; i < marks.length; i++) {
    const block = html.slice(marks[i], i + 1 < marks.length ? marks[i + 1] : marks[i] + 6000);
    const g = (re) => { const m = block.match(re); return m ? m[1] : null; };
    const id = g(/id="post_(\d+)"/);
    if (!id) continue;
    const href = g(/<a href="([^"]+)"\s+class="post_teaser_title_a"/);
    const title = g(/class="post_teaser_title_a"\s*>([\s\S]*?)<\/a>/);
    if (!href || !title) continue;
    const isVideo = block.includes("post_teaser type_4");
    const isImage = block.includes("post_teaser type_3");
    if (!isImage && !isVideo) continue; // text/link posts have no media to show
    const author = g(/<a href="\/u\/([^/"]+)"/);
    const created = g(/<time datetime="([^"]+)"/);
    const score = g(/<span class="score"[^>]*>([^<]*)<\/span>/);
    const comments = g(/Number of comments: (\d+)/);
    let url, thumbnail = null, contentType;
    if (isImage) {
      url = g(/post_teaser_image_preview[\s\S]*?<a href="([^"]+)" class="post_link"/);
      thumbnail = g(/post_teaser_image_preview[\s\S]*?<img src="([^"]+)"/);
      contentType = "image/jpeg";
    } else {
      url = g(/post_teaser_video_preview[\s\S]*?<iframe[^>]*src="([^"]+)"/);
      contentType = "text/html"; // front-end renders this as a link card
    }
    if (!url) continue;
    posts.push({
      post: {
        id: +id,
        name: decodeEntities(title.trim()),
        url,
        thumbnail_url: thumbnail,
        url_content_type: contentType,
        nsfw: block.includes("warning_badge nsfw"),
        ap_id: href.startsWith("/") ? `https://${instance}${href}` : href,
        community_name: communityName,
        created_at: created || null,
        removed: false,
        deleted: false,
      },
      creator: { name: author || "?" },
      community: { name: communityName },
      counters: { score: score ? +score : 0, comment_count: comments ? +comments : 0 },
    });
  }
  return { posts };
}

// Scrape the community page when the JSON API is blocked; on any failure
// keep the original specific 502 message as the last resort.
async function htmlFallback(instance, qs, cacheKey, res) {
  try {
    const community = (new URLSearchParams(qs).get("community_name") || "").replace(/^c\//, "");
    if (!community) throw new Error("no community_name");
    const communityName = community.split("@")[0];
    const page = await fetchHtml(`https://${instance}/c/${encodeURIComponent(communityName)}`);
    if (page.status !== 200 || !page.body || !page.body.includes(" post_teaser type_")) {
      throw new Error("community page not parseable");
    }
    const parsed = parseCommunityPage(page.body, instance, communityName);
    if (!parsed.posts.length) throw new Error("no posts parsed");
    console.log(`→ [html fallback] ${instance}/c/${communityName}: ${parsed.posts.length} posts`);
    cacheSet(cacheKey, parsed);
    res.status(200).json(parsed);
  } catch {
    res.status(502).json({
      error: `${instance} returned a web page, not Lemmy API data — its hosting (PikaPods-style) blocks the JSON API. Ask the instance admin to expose /api/*, or use another instance.`,
    });
  }
}

// ---------------------------------------------------------------------------
// API proxy:  /api/:instance/*  →  https://:instance/api/v3/*
// ---------------------------------------------------------------------------
app.get("/api/:instance/*", (req, res) => {
  const { instance } = req.params;
  const apiPath = req.params[0] || "";
  const qs = req.originalUrl.includes("?")
    ? req.originalUrl.split("?").slice(1).join("?")
    : "";

  if (!isAllowedInstance(instance)) {
    return res.status(400).json({ error: "Unknown or disallowed instance" });
  }

  const cacheKey = `${instance}/${apiPath}${qs ? "?" + qs : ""}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  const target = `https://${instance}/api/v3/${apiPath}${qs ? "?" + qs : ""}`;
  console.log(`→ ${target}`);

  const proxyReq = https.get(
    target,
    {
      headers: {
        "User-Agent": "lemmyp/1.0 (self-hosted Lemmy slideshow)",
        Accept: "application/json",
      },
      timeout: 15_000,
    },
    (proxyRes) => {
      let body = "";
      proxyRes.on("data", (c) => (body += c));
      proxyRes.on("end", () => {
        try {
          const json = JSON.parse(body);
          if (proxyRes.statusCode === 200) cacheSet(cacheKey, json);
          res.status(proxyRes.statusCode).json(json);
        } catch {
          const ct = proxyRes.headers["content-type"] || "";
          const looksHtml = ct.includes("text/html") || /^\s*</.test(body);
          if (looksHtml && apiPath.startsWith("post/list")) {
            return htmlFallback(instance, qs, cacheKey, res);
          }
          if (looksHtml) {
            res.status(502).json({
              error: `${instance} returned a web page, not Lemmy API data — its hosting (PikaPods-style) blocks the JSON API. Ask the instance admin to expose /api/*, or use another instance.`,
            });
          } else {
            res.status(502).json({ error: `Invalid JSON from ${instance}` });
          }
        }
      });
    }
  );

  proxyReq.on("error", (err) =>
    res.status(502).json({ error: `Cannot reach ${instance}`, detail: err.message })
  );
  proxyReq.on("timeout", () => {
    proxyReq.destroy();
    res.status(504).json({ error: `Timed out reaching ${instance}` });
  });
});

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, "public")));

// SPA fallback – any route that isn't an API call or static asset serves index.html
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`lemmyp running on :${PORT}`);
});

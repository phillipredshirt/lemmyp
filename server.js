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
// JSON call comes back as HTML. The server-rendered page honours ?page=N
// (verified 2026-10-29: ~100 posts/page; pages past the end render only the
// pinned post), so the fallback paginates like the JSON API. The NSFW gate is
// bypassed, so every post carries its real nsfw flag and the front-end filter
// still works both ways.
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
    // Title anchor: match the WHOLE opening tag, not a fixed attribute order.
    // Microblog posts carry extra attrs (e.g. rel="noindex") which used to
    // fail the old tight regex and silently dropped most of their posts.
    // One pass: anchor open tag (any attrs) + lazy title content.
    const titleTag = block.match(/<a\b[^>]*class="post_teaser_title_a"[^>]*>([\s\S]*?)<\/a>/);
    if (!titleTag) continue;
    const href = (titleTag[0].match(/href="([^"]+)"/) || [])[1] || null;
    const title = titleTag[1];
    if (!href || !title) continue;
    // Media: detect by PREVIEW block, not type_N — microblog posts use other
    // type numbers (type_7 etc.) but render the identical preview markup.
    const isVideo = block.includes("post_teaser_video_preview");
    const isImage = block.includes("post_teaser_image_preview");
    if (!isImage && !isVideo) continue; // text/link posts have no media to show
    const author = g(/<a href="\/u\/([^/"]+)"/);
    const created = g(/<time datetime="([^"]+)"/);
    const score = g(/<span class="score"[^>]*>([^<]*)<\/span>/);
    const comments = g(/Number of comments: (\d+)/);
    let url = null, thumbnail = null, contentType = null;
    if (isVideo) {
      // Two preview shapes: redgifs/redvids render an <iframe> embed page
      // (front-end shows the site's own player via its url pattern);
      // federated video (Mastodon & co.) renders <video><source src="...mp4">,
      // which the front-end plays natively.
      url = g(/post_teaser_video_preview[\s\S]*?<iframe[^>]*src="([^"]+)"/)
        || g(/post_teaser_video_preview[\s\S]*?<source[^>]*src="([^"]+)"/)
        || g(/post_teaser_video_preview[\s\S]*?<video[^>]*\bsrc="([^"]+)"/);
      if (url) {
        contentType = /redgifs\.com|redvids\.com/i.test(url)
          ? "text/html"   // front-end picks its redgifs branch by URL
          : "video/mp4";  // front-end renders a native <video>
      }
    }
    if (!url && isImage) {
      url = g(/post_teaser_image_preview[\s\S]*?<a href="([^"]+)" class="post_link"/);
      thumbnail = g(/post_teaser_image_preview[\s\S]*?<img src="([^"]+)"/);
      contentType = "image/jpeg";
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
        created_at: created && created !== "None" ? created : null,
        removed: false,
        deleted: false,
      },
      creator: { name: author || "?" },
      community: { name: communityName },
      counters: { score: score ? +score : 0, comment_count: comments ? +comments : 0 },
    });
  }
  return { posts, rawCount: marks.length };
}

// Scrape the community page when the JSON API is blocked; on any failure
// keep the original specific 502 message as the last resort.
async function htmlFallback(instance, qs, cacheKey, res) {
  try {
    const params = new URLSearchParams(qs);
    const community = (params.get("community_name") || "").replace(/^c\//, "");
    if (!community) throw new Error("no community_name");
    const communityName = community.split("@")[0];
    // ?page=N: the server-rendered page paginates (verified 2026-10-29).
    // Without this the fallback always returned page 1, truncating any
    // community bigger than one page (e.g. gonewild: 866 posts -> 85).
    const pageNum = Math.max(1, parseInt(params.get("page") || "1", 10) || 1);
    // layout=list: the instance's default masonry layout server-renders an
    // EMPTY feed for some communities (e.g. redheads@fedinsfw.app), while the
    // list layout always contains the full post markup.
    const page = await fetchHtml(`https://${instance}/c/${encodeURIComponent(communityName)}?layout=list&page=${pageNum}`);
    if (page.status !== 200 || !page.body) {
      throw new Error("community page not fetchable");
    }
    // A page past the end of the feed still returns 200 with the community
    // shell (canonical link) but zero post markers — that is a valid empty
    // feed, not an error. Nonexistent communities return a real 404, and any
    // other 200 that isn't this community's page (gate/login/error) still
    // throws below.
    const isCommunityPage = page.body.includes(" post_teaser type_") ||
      page.body.includes(`/c/${communityName}"`);
    if (!isCommunityPage) {
      throw new Error("community page not parseable");
    }
    const parsed = parseCommunityPage(page.body, instance, communityName);
    // An empty result is a valid end-of-feed signal: pages past the last
    // render only the pinned post (or nothing), which is dropped if it isn't
    // media. Return an empty list (the front-end stops paginating) rather
    // than erroring.
    // A full page (fedinsfw renders 100 posts/page) means another page exists.
    // The rendered "next" button is present even on the LAST page (it leads to
    // a pinned-post-only page), so link presence is not a usable signal.
    const hasMore = parsed.rawCount >= 95;
    console.log(`→ [html fallback] ${instance}/c/${communityName} p${pageNum}: ${parsed.posts.length} posts (raw ${parsed.rawCount}, more=${hasMore})`);
    const out = { posts: parsed.posts, has_more: hasMore };
    cacheSet(cacheKey, out);
    res.status(200).json(out);
  } catch {
    res.status(502).json({
      error: `${instance} returned a web page, not Lemmy API data — its hosting (PikaPods-style) blocks the JSON API. Ask the instance admin to expose /api/*, or use another instance.`,
    });
  }
}

// ---------------------------------------------------------------------------
// Redgifs video duration:  /api/rg-duration?url=<embed page url>
// ---------------------------------------------------------------------------
// Auto-advance must know how long a redgifs video is to hold the slide until
// it finishes. The redgifs v2 API needs a key (401), but the embed page's
// <meta property="og:video:duration"> tag carries the length in seconds. A
// video's duration never changes, so results are cached indefinitely.
const rgDurCache = new Map(); // url -> seconds

app.get("/api/rg-duration", async (req, res) => {
  let u;
  try { u = new URL(req.query.url || ""); } catch {
    return res.status(400).json({ error: "bad url" });
  }
  const host = u.hostname.replace(/^www\./, "");
  if (!["redgifs.com", "redvids.com"].includes(host) ||
      !/^\/(ifr|watch)\//.test(u.pathname)) {
    return res.status(400).json({ error: "not a redgifs embed url" });
  }
  const url = u.toString();
  if (rgDurCache.has(url)) return res.json({ secs: rgDurCache.get(url) });
  const page = await fetchHtml(url);
  const m = page.body && page.body.match(/og:video:duration"\s+content="(\d+(?:\.\d+)?)/);
  const secs = m ? Math.ceil(parseFloat(m[1])) : 0;
  rgDurCache.set(url, secs);
  if (rgDurCache.size > 1000) rgDurCache.delete(rgDurCache.keys().next().value);
  res.json({ secs });
});

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

const express = require("express");
const path = require("path");
const https = require("https");
const dns = require("dns");
const net = require("net");

const app = express();
const PORT = process.env.PORT || 8080;

// ---------------------------------------------------------------------------
// Config — all overridable via env. Defaults are safe for LAN-only daily use.
// ---------------------------------------------------------------------------
const RATE_LIMIT       = parseInt(process.env.RATE_LIMIT || "120", 10);       // sustained req/min per IP (0 = off)
const RATE_LIMIT_BURST = parseInt(process.env.RATE_LIMIT_BURST || "40", 10);  // instant burst per IP
const ALERT_WEBHOOK    = process.env.ALERT_WEBHOOK || "";                     // e.g. https://ntfy.sh/<topic>; empty = log only
const ALERT_COOLDOWN   = parseInt(process.env.ALERT_COOLDOWN || "900", 10) * 1000; // ms between repeat alerts per condition
const SPIKE_PER_IP     = parseInt(process.env.SPIKE_PER_IP || "200", 10);     // req/60s from one IP that alerts
const SPIKE_TOTAL      = parseInt(process.env.SPIKE_TOTAL || "600", 10);      // req/60s total that alerts
const MAX_DISTINCT_IPS = parseInt(process.env.MAX_DISTINCT_IPS || "50", 10);  // distinct IPs/60s that alerts

// ---------------------------------------------------------------------------
// Alerting + anomaly monitoring. With no ALERT_WEBHOOK set this only logs,
// so there is zero behaviour change until you point it at a notification URL
// (ntfy works out of the box: POST the message as a plain-text body).
// ---------------------------------------------------------------------------
const lastAlertAt = new Map(); // condition -> ms
async function alert(condition, message) {
  const now = Date.now();
  if (now - (lastAlertAt.get(condition) || 0) < ALERT_COOLDOWN) return;
  lastAlertAt.set(condition, now);
  const line = `[lemmyp] ${condition}: ${message}`;
  console.warn(line);
  if (!ALERT_WEBHOOK) return;
  try {
    const u = new URL(ALERT_WEBHOOK);
    await new Promise((resolve) => {
      const r = https.request(u, {
        method: "POST",
        headers: { "Content-Type": "text/plain", "X-Priority": "high", "Content-Length": Buffer.byteLength(line) },
        timeout: 5000,
      }, (res) => { res.resume(); res.on("end", resolve); });
      r.on("error", resolve);
      r.on("timeout", () => { r.destroy(); resolve(); });
      r.write(line);
      r.end();
    });
  } catch { /* alerting must never crash the app */ }
}

// sliding 60s window of per-IP request counts + global counters
const WINDOW_MS = 60_000;
let winStart = Date.now();
const winIps = new Map(); // ip -> count in current window
let totalRequests = 0;
let lastSweep = 0;

const monitor = {
  record(req) {
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || "unknown";
    const now = Date.now();
    if (now - winStart > WINDOW_MS) { winIps.clear(); winStart = now; }
    winIps.set(ip, (winIps.get(ip) || 0) + 1);
    totalRequests++;
    if (now - lastSweep < 1000) return; // sweep at most once per second
    lastSweep = now;
    let total = 0, topIp = null, topN = 0;
    for (const [i, n] of winIps) { total += n; if (n > topN) { topN = n; topIp = i; } }
    if (winIps.size > MAX_DISTINCT_IPS) alert("scanning", `${winIps.size} distinct source IPs in 60s (limit ${MAX_DISTINCT_IPS})`);
    if (topN > SPIKE_PER_IP) alert("ip-spike", `${topN} req/60s from ${topIp} (limit ${SPIKE_PER_IP})`);
    if (total > SPIKE_TOTAL) alert("traffic-spike", `${total} req/60s total (limit ${SPIKE_TOTAL})`);
  },
  ssrfAttempt(req, instance) {
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || "unknown";
    alert("ssrf", `disallowed instance "${instance}" requested from ${ip}`);
  },
  rateLimited(req) {
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || "unknown";
    alert("rate-limited", `rate limit hit for ${ip}`);
  },
};

// per-IP token bucket for rate limiting
const buckets = new Map(); // ip -> { tokens, last }
function rateLimitOk(ip) {
  if (RATE_LIMIT <= 0) return true;
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b) { b = { tokens: RATE_LIMIT_BURST, last: now }; buckets.set(ip, b); }
  b.tokens = Math.min(RATE_LIMIT_BURST, b.tokens + (now - b.last) * (RATE_LIMIT / 60000));
  b.last = now;
  if (b.tokens >= 1) { b.tokens -= 1; return true; }
  return false;
}

// periodic cleanup of stale buckets + alert cooldowns
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of buckets) if (now - b.last > 120_000) buckets.delete(ip);
  for (const [c, t] of lastAlertAt) if (now - t > ALERT_COOLDOWN * 2) lastAlertAt.delete(c);
}, 60_000).unref();

// middleware: rate limit + monitoring. /health is exempt so uptime probes
// (Uptime Kuma etc.) don't count against the limits or the anomaly window.
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || "unknown";
  if (!rateLimitOk(ip)) {
    monitor.rateLimited(req);
    return res.status(429).set("Retry-After", "30").json({ error: "Too many requests — slow down" });
  }
  monitor.record(req);
  next();
});

// health endpoint for Uptime Kuma / external probes
app.get("/health", (req, res) => {
  res.json({ ok: true, uptime_s: Math.round(process.uptime()), requests: totalRequests, distinct_ips_60s: winIps.size, cache_entries: cache.size });
});

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

// ---------------------------------------------------------------------------
// SSRF guard. The allowlist above is trusted; anything else must (a) look
// like a bare hostname/IP and (b) resolve ONLY to public addresses. A string
// blocklist alone is bypassable (an attacker domain A-records to 10.x, DNS
// rebinding, IPv6, etc.), so we resolve the name and check every address.
// ---------------------------------------------------------------------------
function ip4ToInt(ip) {
  return ip.split(".").reduce((acc, o) => (acc << 8) + parseInt(o, 10), 0) >>> 0;
}
function inCidrV4(ipInt, cidr) {
  const [base, bits] = cidr.split("/");
  const n = parseInt(bits, 10);
  const mask = n === 0 ? 0 : (~0 << (32 - n)) >>> 0;
  return (ipInt & mask) === (ip4ToInt(base) & mask);
}
const PRIVATE_V4 = [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
  "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16",
  "198.18.0.0/15", "224.0.0.0/4", "240.0.0.0/4",
];
function ip6ToBytes(ip) {
  const s = ip.toLowerCase();
  const v4map = s.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4map) {
    const b = Buffer.alloc(16);
    b[10] = 0xff; b[11] = 0xff; // the "ffff" group of ::ffff:a.b.c.d
    b.set(v4map[1].split(".").map(Number), 12);
    return b;
  }
  let halves;
  if (s.includes("::")) {
    const [left, right] = s.split("::");
    const l = left ? left.split(":") : [];
    const r = right ? right.split(":") : [];
    halves = [...l, ...Array(8 - l.length - r.length).fill("0"), ...r];
  } else {
    halves = s.split(":");
  }
  if (halves.length !== 8) return null;
  const b = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) b.writeUInt16BE(parseInt(halves[i] || "0", 16), i * 2);
  return b;
}
function inCidrV6(buf, cidr) {
  const [base, bits] = cidr.split("/");
  const baseBuf = ip6ToBytes(base);
  const n = parseInt(bits, 10);
  const full = Math.floor(n / 8);
  for (let i = 0; i < full; i++) if (buf[i] !== baseBuf[i]) return false;
  const rem = n % 8;
  if (rem && (buf[full] & (0xff << (8 - rem))) !== (baseBuf[full] & (0xff << (8 - rem)))) return false;
  return true;
}
const PRIVATE_V6 = [
  "::/128", "::1/128", "::ffff:0:0/96", "64:ff9b::/96",
  "fc00::/7", "fe80::/10", "ff00::/8", "2001:db8::/32",
];
function isPrivateOrReserved(ip) {
  const v = net.isIP(ip);
  if (v === 4) return PRIVATE_V4.some((c) => inCidrV4(ip4ToInt(ip), c));
  if (v === 6) {
    const b = ip6ToBytes(ip);
    if (!b) return true; // unparseable -> fail closed
    return PRIVATE_V6.some((c) => inCidrV6(b, c));
  }
  return true; // not an IP literal -> fail closed
}

// Resolve a hostname and require that EVERY address it returns is public.
// Results are cached briefly so the common path adds no per-request DNS cost.
const ipValCache = new Map(); // host -> { ok, time }
const IP_VAL_TTL = 300_000;
async function hostResolvesPublic(host) {
  const now = Date.now();
  const c = ipValCache.get(host);
  if (c && now - c.time < IP_VAL_TTL) return c.ok;
  let ok = false;
  try {
    const addrs = await dns.promises.lookup(host, { all: true, verbatim: true });
    ok = addrs.length > 0 && addrs.every((a) => !isPrivateOrReserved(a.address));
  } catch { ok = false; }
  ipValCache.set(host, { ok, time: now });
  if (ipValCache.size > 2000) ipValCache.delete(ipValCache.keys().next().value);
  return ok;
}

// Allow any public instance. Trusted allowlisted hosts skip the DNS check;
// everything else must resolve to public addresses only (SSRF guard).
async function isAllowedInstance(host) {
  if (ALLOWED_INSTANCES.has(host)) return true;
  if (typeof host !== "string" || host.length > 253 || host.includes("..")) return false;
  if (!/^[a-z0-9.-]+$/i.test(host)) return false; // bare hostname or IP literal only
  return await hostResolvesPublic(host);
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
  // warned=yes bypasses the age gate. anoobis2/anoobis3 are Anubis proof-of-work
  // pass cookies: the server only checks for their PRESENCE (the PoW is a pure
  // client-side delay and the cookie value is ignored — verified 2026-11-19 that
  // anoobis3=garbage still passes). fedinsfw moved from Anubis v2 to v3 in Nov
  // 2026, so the old anoobis2-only cookie started getting the challenge page and
  // every community came back "No media found". Send both so the scraper works on
  // instances running either Anubis version.
  Cookie: "anoobis2=ok; anoobis3=ok; warned=yes",
};

async function fetchHtml(url, redirects = 5) {
  let u;
  try { u = new URL(url); } catch { return { status: 0 }; }
  if (u.protocol !== "https:") return { status: 0 }; // https only
  const first = await new Promise((resolve) => {
    const req = https.get(url, { headers: BROWSER_HEADERS, timeout: 15_000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve({ redirect: new URL(res.headers.location, url).toString(), status: res.statusCode });
      }
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("timeout", () => { req.destroy(); resolve({ status: 0 }); });
    req.on("error", () => resolve({ status: 0 }));
  });
  if (first.redirect && redirects > 0) {
    let nu;
    try { nu = new URL(first.redirect); } catch { return { status: 0 }; }
    // Re-validate the redirect target: https + resolves to a public IP only.
    if (nu.protocol === "https:" && (await hostResolvesPublic(nu.hostname))) {
      return fetchHtml(first.redirect, redirects - 1);
    }
    return { status: first.status, body: "" }; // don't follow an unsafe redirect
  }
  return first;
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

// Guess an image content type from a URL's extension. The front-end only
// needs the "image/" prefix to pick the <img> branch, but keep it accurate.
function guessImageType(url) {
  const ext = (url.split("?")[0].split(".").pop() || "").toLowerCase();
  const map = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp" };
  return map[ext] || "image/jpeg";
}

// Expand multi-image gallery posts. On the community page a single-image
// post's preview links straight to the image (an absolute URL), but a gallery
// post's preview links to the POST PAGE (a relative /c/.../p/... URL) because
// there is no single image to link to. The front-end renders post.url as an
// <img>, so a post-page URL loads an HTML page and shows nothing. For those,
// fetch the post page, read its post_gallery images, and turn one post into N
// slides (one per image) so they play one after the other. If the post page
// can't be fetched, fall back to the preview thumbnail so at least the first
// image still shows. Post pages are fetched in parallel to keep latency down.
async function expandGalleries(posts, instance) {
  const isPostPage = (p) => typeof p.url === "string" && p.url.startsWith("/");
  const galleryIdx = posts.map((item, i) => (isPostPage(item.post) ? i : -1)).filter((i) => i !== -1);
  const galleryImgs = await Promise.all(galleryIdx.map(async (i) => {
    try {
      const page = await fetchHtml(`https://${instance}${posts[i].post.url}`);
      if (page.status === 200 && page.body) {
        // Gallery images carry the gallery-thumbnail class; match the whole
        // <img> tag so attribute order (src before class) doesn't matter.
        return [...page.body.matchAll(/<img\b[^>]*>/g)]
          .map((t) => t[0])
          .filter((t) => /gallery-thumbnail/.test(t))
          .map((t) => (t.match(/src="(https?:\/\/[^"]+)"/) || [])[1])
          .filter(Boolean);
      }
    } catch { /* fall through to thumbnail */ }
    return [];
  }));
  const out = [];
  let gi = 0;
  for (const item of posts) {
    const p = item.post;
    if (!isPostPage(p)) { out.push(item); continue; }
    const imgs = [...new Set(galleryImgs[gi++])]; // dedupe, keep order
    if (imgs.length === 0) {
      // No gallery on the post page — show the preview thumbnail instead of
      // the (unrenderable) post-page URL.
      if (p.thumbnail_url) {
        out.push({ ...item, post: { ...p, url: p.thumbnail_url, url_content_type: guessImageType(p.thumbnail_url) } });
      }
      continue;
    }
    for (const img of imgs) {
      out.push({ ...item, post: { ...p, url: img, thumbnail_url: img, url_content_type: guessImageType(img) } });
    }
  }
  return out;
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
    if (page.status === 404) {
      throw new Error(`Community "${communityName}" not found on ${instance}`);
    }
    if (page.status !== 200 || !page.body) {
      throw new Error(`Community page not fetchable (HTTP ${page.status})`);
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
    // Expand gallery posts (post-page hrefs) into one slide per image.
    const posts = await expandGalleries(parsed.posts, instance);
    console.log(`→ [html fallback] ${instance}/c/${communityName} p${pageNum}: ${posts.length} posts (raw ${parsed.rawCount}, more=${hasMore})`);
    const out = { posts, has_more: hasMore };
    cacheSet(cacheKey, out);
    res.status(200).json(out);
  } catch (err) {
    res.status(502).json({
      error: err.message || `${instance} returned a web page, not Lemmy API data — its hosting (PikaPods-style) blocks the JSON API. Ask the instance admin to expose /api/*, or use another instance.`,
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
app.get("/api/:instance/*", async (req, res) => {
  const { instance } = req.params;
  const apiPath = req.params[0] || "";
  const qs = req.originalUrl.includes("?")
    ? req.originalUrl.split("?").slice(1).join("?")
    : "";

  if (!(await isAllowedInstance(instance))) {
    monitor.ssrfAttempt(req, instance);
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

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
          if (ct.includes("text/html") || /^\s*</.test(body)) {
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

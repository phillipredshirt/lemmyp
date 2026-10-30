/* ============================================================
   lemmyp – frontend
   ============================================================ */

// ---- config -------------------------------------------------------------
const DEFAULT_INSTANCE = "lemmy.world";
const PAGE_SIZE = 25;
const AUTO_DEFAULT = 5; // seconds
// title-tag filter: global (one key for all communities/instances), persisted in localStorage
const TAG_FILTER_KEY = "lemmyp.tagfilter";
const TAG_FILTER_DEFAULT = "-t m>f"; // no [t], and no [m]-without-[f]
const PREFETCH_AT = 4;  // fetch next page when this many slides remain

const INSTANCES = [
  { id: "lemmy.world",         label: "lemmy.world" },
  { id: "lemmynsfw.com",       label: "lemmynsfw.com" },
  { id: "sh.itjust.works",     label: "sh.itjust.works" },
  { id: "lemmy.ml",            label: "lemmy.ml" },
  { id: "feddit.ex.solar",     label: "feddit.ex.solar" },
  { id: "lemmy.ca",            label: "lemmy.ca" },
  { id: "melroy.dev",          label: "melroy.dev" },
  { id: "post.lurk.org",       label: "post.lurk.org" },
  { id: "k8s.kevin.dk",        label: "k8s.kevin.dk" },
  { id: "federated.lgbtq.love",label: "federated.lgbtq.love" },
  { id: "lemmy.hue.rain",      label: "lemmy.hue.rain" },
  { id: "saas.pov.lt",         label: "saas.pov.lt" },
  { id: "bearblog.dev",        label: "bearblog.dev" },
  { id: "midwest.social",      label: "midwest.social" },
  { id: "fedinsfw.app",        label: "fedinsfw.app  🍑" },
  { id: "lemmy.owo",           label: "lemmy.owo" },
  { id: "lemmy.sikaei.nl",     label: "lemmy.sikaei.nl" },
  { id: "lemmy.ch",            label: "lemmy.ch" },
  { id: "lemmyverse.com",      label: "lemmyverse.com" },
  { id: "lemmy.cx",            label: "lemmy.cx" },
  { id: "rles.nohost.network", label: "rles.nohost.network" },
];

// ---- state --------------------------------------------------------------
const S = {
  instance:  DEFAULT_INSTANCE,
  community: null,
  sort:      "Hot",
  page:      1,
  posts:     [],
  slides:    [],          // filtered media-only
  idx:       0,
  hasMore:   true,
  loading:   false,
  auto:      false,
  autoTimer: null,
  autoStart: 0,      // when the current slide's wait began
  autoFireAt: 0,     // when the pending auto-advance timer will fire
  autoSec:   AUTO_DEFAULT,
  autoPicsOnly: localStorage.getItem("lemmyp.autopics") === "1", // auto skips images only; holds on videos
  sound:     false,
  nsfwOn:    true,        // show NSFW by default
  titleVis:  true,
  ctrlVis:   true,
  lastMouse: Date.now(),
  // title-tag filter (global, persisted)
  filterExpr:  localStorage.getItem(TAG_FILTER_KEY) ?? TAG_FILTER_DEFAULT,
  filter:      null,      // parsed; set in init()
  hiddenCount: 0,         // posts dropped by the tag filter (loaded pages)
  tagPanelOpen:false,
};

// ---- DOM shortcuts -------------------------------------------------------
const $ = (id) => document.getElementById(id);
const el = {
  slideshow:   $("slideshow"),
  mediaBox:    $("slide-media"),
  ctrlBar:     $("ctrl-bar"),
  ctrlContext: $("ctrl-context"),
  counter:     $("slide-counter"),
  titleBar:    $("title-bar"),
  postTitle:   $("post-title"),
  metaComm:    $("meta-community"),
  metaScore:   $("meta-score"),
  metaCmt:     $("meta-comments"),
  metaCreator: $("meta-creator"),
  metaNsfw:    $("meta-nsfw"),
  loading:     $("loading-overlay"),
  errOverlay:  $("error-overlay"),
  errMsg:      $("error-msg"),
  selector:    $("selector"),
  selInstance: $("sel-instance"),
  selCommunity:$("sel-community"),
  selSort:     $("sel-sort"),
  selStart:    $("sel-start"),
  toast:       $("toast"),
  btnAuto:     $("btn-auto"),
  btnPics:     $("btn-pics"),
  autoTimer:   $("auto-timer"),
  btnSound:    $("btn-sound"),
  btnFull:     $("btn-full"),
  btnTitle:    $("btn-title"),
  btnNsfw:     $("btn-nsfw"),
  btnPost:     $("btn-post"),
  btnPrev:     $("btn-prev"),
  btnNext:     $("btn-next"),
  btnRetry:    $("btn-retry"),
  btnTags:     $("btn-tags"),
  tagCount:    $("tag-count"),
  tagPanel:    $("tag-panel"),
  tagInput:    $("tag-input"),
  tagHidden:   $("tag-hidden"),
};

// ---- URL parsing ---------------------------------------------------------
function parseUrl() {
  const u = new URL(location.href);
  // /c/community  or  /u/username
  const m = u.pathname.match(/^\/(c|u)\/([^/?]+)/);
  if (m) {
    if (m[1] === "c") S.community = decodeURIComponent(m[2]);
    // /u/ is phase 3, not yet implemented
  }
  // query params override
  if (u.searchParams.get("instance")) S.instance = u.searchParams.get("instance");
  if (u.searchParams.get("c"))        S.community = u.searchParams.get("c");
  if (u.searchParams.get("sort"))     S.sort = u.searchParams.get("sort");
}

function buildShareUrl() {
  const u = new URL(location.origin);
  u.pathname = "/c/" + encodeURIComponent(S.community);
  u.searchParams.set("instance", S.instance);
  if (S.sort !== "Hot") u.searchParams.set("sort", S.sort);
  return u.toString();
}

// ---- API -----------------------------------------------------------------
async function fetchPosts(page, append) {
  const q = new URLSearchParams();
  // Lemmy post/list takes "community_name" (NOT "c") -- "c" is silently
  // ignored upstream, so every sub would show the instance's base feed.
  // Lemmy wants the bare short name ("memes") or "name@instance" -- the
  // "c/memes" display form is NOT accepted (404), so strip it if typed.
  if (S.community) q.set("community_name", S.community.replace(/^c\//, ""));
  // Always ask for NSFW posts: many Lemmy instances (lemmy.world included)
  // strip them from anonymous responses unless this flag is set. The N key
  // then filters client-side (see the media filter below), so the toggle
  // actually works in both directions.
  q.set("show_nsfw", "true");
  q.set("sort", S.sort);
  q.set("limit", String(PAGE_SIZE));
  q.set("page", String(page));

  const url = `/api/${S.instance}/post/list?${q}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  const data = await res.json();
  const posts = data.posts || [];

  // keep only posts with a URL (skip text-only), apply NSFW + tag filters
  let hidden = 0;
  const media = posts.filter(p => {
    const post = p.post;
    if (!post || post.deleted || post.removed) return false;
    if (!post.url) return false;
    if (S.nsfwOn === false && post.nsfw) return false;
    if (!tagPasses(post.name)) { hidden++; return false; }
    return true;
  });

  if (append) {
    // de-dupe by post id
    const existing = new Set(S.slides.map(s => s.post.id));
    const fresh = media.filter(p => !existing.has(p.post.id));
    S.slides.push(...fresh);
    S.hiddenCount += hidden;
  } else {
    S.slides = media;
    S.hiddenCount = hidden;
  }
  // The HTML fallback (fedinsfw-style instances) reports has_more explicitly:
  // a text-heavy community (e.g. microblogs) can yield fewer than PAGE_SIZE
  // media posts per server-rendered page, which made the length heuristic
  // stop early (microblogs truncated at ~61 of ~2700 posts). Real Lemmy
  // post/list has no has_more field, so the heuristic stays for those.
  S.hasMore = (typeof data.has_more === "boolean")
    ? data.has_more
    : posts.length >= PAGE_SIZE;
  S.page = page;
  updateTagUI();
  return media.length;
}

// ---- slide type detection ------------------------------------------------
function slideType(post) {
  const ct = post.url_content_type || "";
  const url = post.url || "";
  // redgifs/redvids embed pages: render their own iframe player inline
  // (the /ifr/ URL exists specifically to be embedded in an <iframe>).
  if (/^https?:\/\/(www\.)?(redgifs|redvids)\.com\/(ifr|watch)\//i.test(url)) return "redgifs";
  if (ct.startsWith("image/")) return "image";
  if (ct.startsWith("video/")) return "video";
  // heuristic: common image/video extensions
  if (/(\.(jpe?g|png|gif|webp|avif|bmp|svg))($|[?#])/i.test(url)) return "image";
  if (/(\.(mp4|webm|ogg|mov))($|[?#])/i.test(url)) return "video";
  return "link";
}

function isGif(post) {
  return (post.url_content_type || "") === "image/gif" ||
         /\.gif($|[?#])/i.test(post.url || "");
}

// ---- GIF duration measurement --------------------------------------------
// GIFs render as <img>, which doesn't expose their length. But the frame
// delays live in the file header (GIF89a Graphic Control Extensions), so we
// fetch the file and sum them. The <img> tag already loaded the same URL,
// so this fetch normally hits the browser's HTTP cache. Cross-origin hosts
// that block fetches make this fail - caller falls back to the base delay.
const gifDurCache = new Map(); // url -> seconds

async function gifDuration(url) {
  if (gifDurCache.has(url)) return gifDurCache.get(url);
  try {
    const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
    // header "GIF8" + logical screen descriptor
    if (buf.length < 13 || buf[0] !== 0x47 || buf[1] !== 0x49 || buf[2] !== 0x46)
      return null;
    let i = 13;
    if (buf[10] & 0x80) i += 3 << ((buf[10] & 0x70) >> 3); // global color table (2^N entries)
    let secs = 0, pending = 0; // pending: delay (cs) from the most recent GCE
    while (i < buf.length) {
      const b = buf[i];
      if (b === 0x3B) break; // trailer
      if (b === 0x21) {      // extension block
        if (buf[i + 1] === 0xF9) {  // graphic control extension (fixed 8 bytes)
          pending = buf[i + 3] | (buf[i + 4] << 8);
          i += 8;
        } else {              // comment / app extension: skip data sub-blocks
          i += 3;
          while (i < buf.length && buf[i] !== 0) i += 1 + buf[i];
          i += 1;
        }
      } else if (b === 0x2C) { // image descriptor = one frame
        let j = i + 10;
        if (buf[i + 9] & 0x80) j += 3 << ((buf[i + 9] & 0x70) >> 3); // LCT (2^N entries)
        j += 1;                               // LZW minimum code size
        while (j < buf.length && buf[j] !== 0) j += 1 + buf[j]; // image data blocks
        secs += (pending > 0 ? pending : 10) / 100; // delay 0 -> 100ms default
        pending = 0;
        i = j + 1;
      } else i += 1;
    }
    gifDurCache.set(url, secs);
    return secs;
  } catch { return null; }
}

// ---- redgifs duration ---------------------------------------------
// redgifs embeds are cross-origin iframes, so the player's duration can't
// be read from our DOM. Their /ifr/ page, however, carries the length in an
// og:video:duration meta tag, which our proxy can read - see /api/rg-duration.
const rgDurCache = new Map(); // post url -> seconds (0 = unknown)

async function rgDuration(postUrl) {
  if (rgDurCache.has(postUrl)) return rgDurCache.get(postUrl);
  let secs = 0;
  try {
    const r = await fetch(`/api/rg-duration?url=${encodeURIComponent(postUrl)}`);
    if (r.ok) secs = (await r.json()).secs || 0;
  } catch {}
  rgDurCache.set(postUrl, secs);
  return secs;
}

// ---- rendering -----------------------------------------------------------
function renderSlide() {
  const box = el.mediaBox;
  box.innerHTML = "";
  stopVideo();

  if (S.slides.length === 0) {
    box.innerHTML = `<div style="color:var(--text-dim);font-size:1.1em">No media found<br><small>Try a different community or sort${S.filterExpr ? " · or clear the tag filter (Tags)" : ""}</small></div>`;
    updateMeta();
    return;
  }

  // Each slide item is the full API response: { post, creator, community, counters }
  const item = S.slides[S.idx];
  const post = item.post;
  const type = slideType(post);

  if (type === "image") {
    const img = document.createElement("img");
    img.src = post.url;
    img.alt = post.name || "";
    img.draggable = false;
    box.appendChild(img);
  } else if (type === "video") {
    const vid = document.createElement("video");
    vid.src = post.url;
    vid.controls = true;
    vid.autoplay = true;
    vid.muted = !S.sound;
    vid.playsInline = true;
    // duration is unknown until metadata loads; re-check it so a long
    // video isn't cut off by the base auto-advance delay
    vid.addEventListener("loadedmetadata", () => { if (S.auto) scheduleAuto(); });
    box.appendChild(vid);
  } else if (type === "redgifs") {
    // redgifs /ifr/ embed page: render the site's own player.
    // Loaded in the user's browser (not proxied), so redgifs' CDN/UA
    // restrictions don't apply. Full box: the player manages its own size.
    const frame = document.createElement("iframe");
    // /watch/ is the page URL Lemmy JSON stores; /ifr/ is the
    // frame-able embed — normalize to the embed form.
    frame.src = post.url.replace(/\/watch\//, "/ifr/");
    frame.className = "rg-frame";
    frame.allowFullscreen = true;
    frame.setAttribute("allow", "autoplay; fullscreen");
    frame.referrerPolicy = "no-referrer";
    box.appendChild(frame);
  } else {
    // link card
    const card = document.createElement("div");
    card.className = "link-card";
    card.onclick = (e) => { e.stopPropagation(); window.open(post.url, "_blank", "noopener"); };

    if (post.thumbnail_url) {
      const thumb = document.createElement("img");
      thumb.src = post.thumbnail_url;
      thumb.alt = "";
      card.appendChild(thumb);
    }
    const t = document.createElement("div");
    t.className = "lc-title";
    t.textContent = post.name || "(untitled)";
    card.appendChild(t);

    const u = document.createElement("div");
    u.className = "lc-url";
    try { u.textContent = new URL(post.url).hostname; } catch { u.textContent = post.url; }
    card.appendChild(u);

    box.appendChild(card);
  }

  updateMeta();
  preloadNext();
  holdToastId = null; // allow the pics-only hold toast to fire once for this slide
  if (S.auto) scheduleAuto(); // manual nav while auto is on: restart the wait
}

function updateMeta() {
  if (S.slides.length === 0) {
    el.postTitle.textContent = "";
    el.counter.textContent = "";
    return;
  }
  const item = S.slides[S.idx];
  const post     = item.post;
  const counters = item.counters || {};
  const community = item.community || {};
  const creator   = item.creator   || {};

  el.postTitle.textContent  = post.name || "";
  el.metaComm.textContent   = community.name ? `c/${community.name}` : "";
  el.metaScore.textContent  = `▲ ${counters.score ?? 0}`;
  el.metaCmt.textContent    = `💬 ${counters.comment_count ?? 0}`;
  el.metaCreator.textContent = creator.name ? `u/${creator.name}` : "";
  el.metaNsfw.classList.toggle("show", !!post.nsfw);

  el.counter.textContent = `${S.idx + 1} / ${S.slides.length}${S.hasMore ? "…" : ""}`;
  el.ctrlContext.textContent = `${S.instance}  ·  /c/${S.community || "all"}  ·  ${S.sort}`;
}

// ---- preload --------------------------------------------------------------
function preloadNext() {
  const nextIdx = S.idx + 1;
  if (nextIdx >= S.slides.length) return;
  const post = S.slides[nextIdx].post;
  const type = slideType(post);
  if (type === "image" && post.url) {
    const img = new Image();
    img.src = post.url;
  } else if (type === "video" && post.url) {
    // warm the video connection without playing
    const v = document.createElement("video");
    v.preload = "metadata";
    v.src = post.url;
  }
}

// ---- navigation ----------------------------------------------------------
function next() {
  if (S.idx < S.slides.length - 1) {
    S.idx++;
    renderSlide();
  }
  maybePrefetch();
}

function prev() {
  if (S.idx > 0) {
    S.idx--;
    renderSlide();
  }
}

function goTo(i) {
  S.idx = Math.max(0, Math.min(i, S.slides.length - 1));
  renderSlide();
}

function stopVideo() {
  const v = el.mediaBox.querySelector("video");
  if (v) { v.pause(); v.src = ""; v.load(); }
}

// ---- prefetch next page --------------------------------------------------
async function maybePrefetch() {
  if (!S.hasMore || S.loading) return;
  const remaining = S.slides.length - 1 - S.idx;
  if (remaining <= PREFETCH_AT) {
    S.loading = true;
    await fetchPosts(S.page + 1, true).catch(() => {});
    S.loading = false;
  }
}

// ---- auto-advance --------------------------------------------------------
// Waits at least S.autoSec between slides, but never cuts a slide's media
// short: a 10s GIF (or video) waits the full 10s even at a 5s setting.
function autoAdvanceTick() {
  if (!S.auto) return;
  S.autoFireAt = 0;
  next();
  if (!S.auto) return; // navigation may have turned auto off
  if (!S.hasMore && S.idx >= S.slides.length - 1) { toggleAuto(); return; }
  scheduleAuto();
}

function scheduleAuto() {
  clearTimeout(S.autoTimer);
  if (!S.auto) return;

  const item = S.slides[S.idx];
  const type = item ? slideType(item.post) : null;

  // Pics-only option: auto-advance only skips images. A video (native or
  // redgifs embed) holds indefinitely until the user advances it, so the
  // clip plays in full. renderSlide() re-schedules on every slide change,
  // so moving to an image re-arms the timer automatically.
  if (S.autoPicsOnly && (type === "video" || type === "redgifs")) {
    S.autoTimer = null;
    S.autoFireAt = 0;
    S.autoStart = 0;
    if (holdToastId !== item.post.id) {
      holdToastId = item.post.id;
      toast("Pics-only: holding on video — press → or ❯ to continue", 3500);
    }
    return;
  }

  let delay = S.autoSec * 1000;
  if (type === "video") {
    const v = el.mediaBox.querySelector("video");
    if (v && isFinite(v.duration) && v.duration > 0)
      delay = Math.max(delay, v.duration * 1000);
  } else if (type === "image" && item && isGif(item.post)) {
    const url = item.post.url;
    const cached = gifDurCache.get(url);
    if (cached) {
      delay = Math.max(delay, cached * 1000);
    } else {
      // Parse the GIF in the background; if it turns out longer than the
      // base wait, push the pending timer out. (CORS failures just fall
      // back to the base delay.)
      gifDuration(url).then(d => {
        if (!S.auto || !d) return;
        const cur = S.slides[S.idx];
        if (!cur || cur.post.url !== url) return; // slide changed in the meantime
        const target = S.autoStart + Math.max(S.autoSec * 1000, d * 1000);
        if (target > S.autoFireAt && target > Date.now()) {
          S.autoFireAt = target;
          S.autoTimer = setTimeout(autoAdvanceTick, target - Date.now());
        }
      });
    }
  } else if (type === "redgifs" && item) {
    // Hold the slide for the full video length: ask the proxy for the
    // duration and push the pending timer out if it beats the base wait.
    const url = item.post.url;
    const cached = rgDurCache.get(url);
    if (cached) {
      delay = Math.max(delay, cached * 1000);
    } else {
      rgDuration(url).then(d => {
        if (!S.auto || !d) return;
        const cur = S.slides[S.idx];
        if (!cur || cur.post.url !== url) return; // slide changed in the meantime
        const target = S.autoStart + Math.max(S.autoSec * 1000, d * 1000);
        if (target > S.autoFireAt && target > Date.now()) {
          S.autoFireAt = target;
          S.autoTimer = setTimeout(autoAdvanceTick, target - Date.now());
        }
      });
    }
  }

  S.autoStart = Date.now();
  S.autoFireAt = S.autoStart + delay;
  S.autoTimer = setTimeout(autoAdvanceTick, delay);
}

function toggleAuto() {
  S.auto = !S.auto;
  el.btnAuto.classList.toggle("active", S.auto);
  if (S.auto) {
    scheduleAuto();
    el.autoTimer.textContent = `${S.autoSec}s`;
  } else {
    S.autoStart = 0;
    S.autoFireAt = 0;
    clearTimeout(S.autoTimer);
    el.autoTimer.textContent = "";
  }
}

// Pics-only: auto advances images only; videos hold until advanced, so
// they play in full. Persisted globally in localStorage.
let holdToastId = null; // post id the hold toast was already shown for

function toggleAutoPicsOnly() {
  S.autoPicsOnly = !S.autoPicsOnly;
  el.btnPics.classList.toggle("active", S.autoPicsOnly);
  try { localStorage.setItem("lemmyp.autopics", S.autoPicsOnly ? "1" : "0"); } catch (e) {}
  toast(S.autoPicsOnly
    ? "Pics-only on: auto advances pictures, holds on videos"
    : "Pics-only off: auto advances every slide");
  if (S.auto) scheduleAuto(); // re-evaluate: hold now, or re-arm the timer
}

// ---- focus guard ---------------------------------------------------------
// Clicking the redgifs player (or a <video>) moves DOM focus into that
// element's own document; after switching OS windows and back, keys keep
// going in there and the app's shortcuts die (only the Auto button worked).
// When the window regains focus, hand keyboard focus back to this document.
function setupFocusGuard() {
  window.addEventListener("focus", () => {
    const a = document.activeElement;
    if (a && a.tagName === "IFRAME") a.blur();
  });
}

// ---- fullscreen ----------------------------------------------------------
function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    document.documentElement.requestFullscreen().catch(() => {});
  }
}

// ---- sound ---------------------------------------------------------------
function toggleSound() {
  S.sound = !S.sound;
  el.btnSound.textContent = S.sound ? "🔊" : "🔇";
  const v = el.mediaBox.querySelector("video");
  if (v) v.muted = !S.sound;
}

// ---- NSFW ----------------------------------------------------------------
function toggleNsfw() {
  S.nsfwOn = !S.nsfwOn;
  el.btnNsfw.classList.toggle("active", S.nsfwOn);
  // re-fetch to apply filter
  S.page = 1;
  S.slides = [];
  S.idx = 0;
  startSlideshow();
}

// ---- title-tag filter ----------------------------------------------------
// Extract every [bracketed] token from a title (any position), lowercased,
// so [M]/[m] match. Returns a Set of tags.
function extractTags(title) {
  const tags = new Set();
  if (!title) return tags;
  const m = String(title).match(/\[[^\]]+\]/g);
  if (m) for (const t of m) {
    const inner = t.slice(1, -1).trim().toLowerCase();
    if (inner) tags.add(inner);
  }
  return tags;
}

// Parse the mini-syntax into { required:[orGroups], blocked:[tags], rules:[[ant,cons]] }.
//   +tag / +a|b   require tag / require (a or b)
//   -tag / -a|b   block if tag present
//   a>b / a>b|c   if a present, require (b or c)
//   bare tag      = +tag
function parseFilter(expr) {
  const f = { required: [], blocked: [], rules: [] };
  if (!expr) return f;
  for (let tok of String(expr).trim().split(/\s+/)) {
    if (!tok) continue;
    if (tok[0] === "+") {
      const g = tok.slice(1).split("|").map(t => t.trim().toLowerCase()).filter(Boolean);
      if (g.length) f.required.push(g);
    } else if (tok[0] === "-") {
      for (const t of tok.slice(1).split("|")) {
        const tag = t.trim().toLowerCase();
        if (tag) f.blocked.push(tag);
      }
    } else if (tok.includes(">")) {
      const [a, b] = tok.split(">");
      const ant = a.trim().toLowerCase();
      const cons = b.split("|").map(t => t.trim().toLowerCase()).filter(Boolean);
      if (ant && cons.length) f.rules.push([ant, cons]);
    } else {
      const tag = tok.toLowerCase();
      if (tag) f.required.push([tag]);
    }
  }
  return f;
}

// Does a post title pass the current filter?
function tagPasses(title) {
  const f = S.filter;
  if (!f) return true;
  const tags = extractTags(title);
  for (const g of f.required) if (!g.some(t => tags.has(t))) return false;
  for (const t of f.blocked)  if (tags.has(t)) return false;
  for (const [ant, cons] of f.rules) if (tags.has(ant) && !cons.some(t => tags.has(t))) return false;
  return true;
}

function applyFilter(expr) {
  S.filterExpr = expr == null ? "" : String(expr).trim();
  S.filter = parseFilter(S.filterExpr);
  try { localStorage.setItem(TAG_FILTER_KEY, S.filterExpr); } catch (e) {}
  el.tagInput.value = S.filterExpr;
  syncTagPresets();
  updateTagUI();
  // re-fetch from page 1 with the new filter (same path as the NSFW toggle)
  startSlideshow();
}

function updateTagUI() {
  el.btnTags.classList.toggle("active", S.filterExpr !== "");
  el.btnTags.classList.toggle("has-hidden", S.hiddenCount > 0);
  el.tagCount.textContent = S.hiddenCount > 0 ? String(S.hiddenCount) : "";
  el.tagHidden.textContent = S.hiddenCount > 0 ? S.hiddenCount + " hidden by filter" : "no filter active";
}

function syncTagPresets() {
  document.querySelectorAll(".tag-preset").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.expr === S.filterExpr);
  });
}

function openTagPanel() {
  S.tagPanelOpen = true;
  el.tagPanel.classList.remove("hidden");
  el.ctrlBar.classList.remove("hide");   // keep the bar (and panel) visible
  el.tagInput.value = S.filterExpr;
  syncTagPresets();
}
function closeTagPanel() {
  S.tagPanelOpen = false;
  el.tagPanel.classList.add("hidden");
}
function toggleTagPanel() {
  if (S.tagPanelOpen) closeTagPanel(); else openTagPanel();
}

// ---- title / controls visibility -----------------------------------------
function toggleTitle() {
  S.titleVis = !S.titleVis;
  el.titleBar.classList.toggle("hide", !S.titleVis);
}
function toggleControls() {
  S.ctrlVis = !S.ctrlVis;
  el.ctrlBar.classList.toggle("hide", !S.ctrlVis);
}

// auto-hide bars after mouse idle (only if user hasn't manually hidden them)
function onMouseMove() {
  S.lastMouse = Date.now();
  if (S.ctrlVis)  el.ctrlBar.classList.remove("hide");
  if (S.titleVis) el.titleBar.classList.remove("hide");
}
setInterval(() => {
  if (S.tagPanelOpen) return;   // keep the bar + panel visible while editing
  if (Date.now() - S.lastMouse > 3000) {
    if (S.ctrlVis)  el.ctrlBar.classList.add("hide");
    if (S.titleVis) el.titleBar.classList.add("hide");
  }
}, 500);

// ---- toast ---------------------------------------------------------------
let toastTimeout;
function toast(msg, ms = 2500) {
  el.toast.textContent = msg;
  el.toast.classList.add("show");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => el.toast.classList.remove("show"), ms);
}

// ---- loading / error -----------------------------------------------------
function showLoading(on) {
  el.loading.classList.toggle("hidden", !on);
}
function showError(msg) {
  el.errMsg.textContent = msg;
  el.errOverlay.classList.remove("hidden");
}
function hideError() {
  el.errOverlay.classList.add("hidden");
}

// ---- main flow -----------------------------------------------------------
async function startSlideshow() {
  el.selector.classList.add("hidden");
  el.slideshow.classList.remove("hidden");
  hideError();
  showLoading(true);
  S.idx = 0;
  S.page = 1;
  S.slides = [];
  S.hasMore = true;
  S.hiddenCount = 0;
  S.lastMouse = Date.now();

  try {
    const count = await fetchPosts(1, false);
    if (count === 0) {
      el.mediaBox.innerHTML = `<div style="color:var(--text-dim);font-size:1.1em">No media found<br><small>Try a different community or sort${S.filterExpr ? " · or clear the tag filter (Tags)" : ""}</small></div>`;
    } else {
      renderSlide();
    }
  } catch (err) {
    showError(`Failed to load posts: ${err.message}`);
  } finally {
    showLoading(false);
  }
}

function showSelector() {
  el.slideshow.classList.add("hidden");
  el.selector.classList.remove("hidden");
  // pre-fill
  el.selInstance.value = S.instance;
  if (S.community) el.selCommunity.value = S.community;
}

// ---- keyboard ------------------------------------------------------------
function setupKeys() {
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;

    switch (e.key) {
      case "ArrowRight": case " ": case "PageDown":
        e.preventDefault(); next(); break;
      case "ArrowLeft": case "PageUp":
        e.preventDefault(); prev(); break;
      case "Escape":
        if (document.fullscreenElement) return; // let browser handle
        if (S.tagPanelOpen) { closeTagPanel(); break; }
        showSelector(); break;
      case "f": case "F": toggleFullscreen(); break;
      case "m": case "M": toggleSound(); break;
      case "t": case "T": toggleTitle(); break;
      case "a": case "A": toggleAuto(); break;
      case "v": case "V": toggleAutoPicsOnly(); break;
      case "n": case "N": toggleNsfw(); break;
      case "g": case "G": toggleTagPanel(); break;
      case "o": case "O": openPost(); break;
      case "c": case "C": copyLink(); break;
      case "p": case "P": toggleControls(); break;
      case "Home": goTo(0); break;
      case "End":  goTo(S.slides.length - 1); break;
    }
  });
}

function openPost() {
  if (S.slides.length === 0) return;
  const post = S.slides[S.idx].post;
  window.open(post.ap_id || post.url, "_blank", "noopener");
  // ap_id is the canonical Lemmy post URL (e.g. https://lemmy.world/post/12345)
}

function copyLink() {
  navigator.clipboard.writeText(buildShareUrl()).then(
    () => toast("Link copied"),
    () => toast("Copy failed")
  );
}

// ---- touch / swipe -------------------------------------------------------
let touchStartX = 0, touchStartY = 0;
function setupTouch() {
  document.addEventListener("touchstart", (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });

  document.addEventListener("touchend", (e) => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
      if (dx < 0) next(); else prev();
    }
  }, { passive: true });
}

// ---- mouse click to navigate (left/right halves) -------------------------
function setupClick() {
  el.mediaBox.addEventListener("click", (e) => {
    // don't navigate when interacting with a video, iframe, or link-card
    if (e.target.closest("video") || e.target.tagName === "IFRAME" || e.target.closest(".link-card")) return;
    const half = window.innerWidth / 2;
    if (e.clientX > half) next(); else prev();
  });

  // double-click anywhere on the media = fullscreen
  el.mediaBox.addEventListener("dblclick", (e) => {
    if (e.target.closest("video") || e.target.tagName === "IFRAME" || e.target.closest(".link-card")) return;
    toggleFullscreen();
  });
}

// ---- selector wiring -----------------------------------------------------
function setupSelector() {
  // populate instance list
  INSTANCES.forEach(inst => {
    const opt = document.createElement("option");
    opt.value = inst.id;
    opt.textContent = inst.label;
    el.selInstance.appendChild(opt);
  });

  el.selStart.onclick = () => {
    S.instance = el.selInstance.value;
    S.community = el.selCommunity.value.trim() || null;
    S.sort = el.selSort.value;
    if (!S.community) {
      toast("Enter a community name");
      return;
    }
    // update URL without reload
    history.pushState(null, "", `/c/${encodeURIComponent(S.community)}?instance=${S.instance}&sort=${S.sort}`);
    startSlideshow();
  };

  // Enter key in community input
  el.selCommunity.addEventListener("keydown", (e) => {
    if (e.key === "Enter") el.selStart.click();
  });
}

// ---- back/forward (history) ----------------------------------------------
window.addEventListener("popstate", () => {
  parseUrl();
  if (S.community) {
    startSlideshow();
  } else {
    showSelector();
  }
});

// ---- button wiring -------------------------------------------------------
function setupButtons() {
  el.btnAuto.onclick    = toggleAuto;
  el.btnPics.onclick    = toggleAutoPicsOnly;
  el.btnSound.onclick   = toggleSound;
  el.btnFull.onclick    = toggleFullscreen;
  el.btnTitle.onclick   = toggleTitle;
  el.btnNsfw.onclick    = toggleNsfw;
  el.btnTags.onclick    = toggleTagPanel;
  el.btnPost.onclick    = openPost;
  el.btnRetry.onclick   = () => { hideError(); startSlideshow(); };
  el.btnPrev.onclick    = prev;
  el.btnNext.onclick    = next;

  // NSFW button starts active (NSFW shown)
  el.btnNsfw.classList.add("active");
  el.btnPics.classList.toggle("active", S.autoPicsOnly);

  // tag filter: presets, text field, initial state
  document.querySelectorAll(".tag-preset").forEach(btn => {
    btn.onclick = () => applyFilter(btn.dataset.expr);
  });
  el.tagInput.addEventListener("change", () => applyFilter(el.tagInput.value));
  el.tagInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); applyFilter(el.tagInput.value); el.tagInput.blur(); }
  });
  el.tagInput.value = S.filterExpr;
  updateTagUI();

  // close the panel on a click outside it (but not on the Tags button itself)
  document.addEventListener("click", (e) => {
    if (!S.tagPanelOpen) return;
    if (e.target.closest("#tag-panel") || e.target.closest("#btn-tags")) return;
    closeTagPanel();
  });

  document.addEventListener("mousemove", onMouseMove, { passive: true });
}

// ---- init ----------------------------------------------------------------
function init() {
  S.filter = parseFilter(S.filterExpr);
  parseUrl();
  setupSelector();
  setupButtons();
  setupKeys();
  setupTouch();
  setupClick();
  setupFocusGuard();

  if (S.community) {
    startSlideshow();
  } else {
    showSelector();
  }
}

document.addEventListener("DOMContentLoaded", init);

/* 山河武俠演示 service worker：殼層網路優先，Pyodide／字型快取優先。 */
const VERSION = "20261120-2056";
const CACHE_IMMUTABLE = "shanhe-immutable-" + VERSION;
const CACHE_RUNTIME = "shanhe-runtime-" + VERSION;

const SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./version.json",
  "./favicon.svg",
  "./css/app.css",
  "./js/app.js",
  "./js/worker.js",
  "./js/rig.js",
  "./js/motion.js",
  "./js/pwa.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

const IMMUTABLE_PREFIXES = [
  "/vendor/pyodide/",
  "/vendor/fonts/",
];

function sameOrigin(url) {
  return url.origin === self.location.origin;
}

function isImmutable(url) {
  const path = url.pathname;
  return IMMUTABLE_PREFIXES.some((p) => path.includes(p));
}

function isNetworkFirst(url) {
  const path = url.pathname;
  if (isImmutable(url)) return false;
  return (
    path.endsWith("/") ||
    /\.(html?|js|css|json|webmanifest|zip)$/i.test(path)
  );
}

async function fromNetwork(request, cacheName, timeoutMs) {
  const ctrl = new AbortController();
  const timer = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const response = await fetch(request, { signal: timeoutMs ? ctrl.signal : undefined, cache: "no-store" });
    if (timer) clearTimeout(timer);
    if (response && response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    if (timer) clearTimeout(timer);
    throw err;
  }
}

async function networkFirst(request) {
  try {
    const response = await fromNetwork(request, CACHE_RUNTIME, 8000);
    if (response && (response.ok || response.type === "opaque")) return response;
  } catch (_) {
    /* fall through to cache */
  }
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) return cached;
  if (request.mode === "navigate") {
    const shell = await caches.match("./index.html") || await caches.match("./");
    if (shell) return shell;
  }
  return fetch(request);
}

async function cacheFirst(request) {
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) {
    const cache = await caches.open(CACHE_IMMUTABLE);
    cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_RUNTIME);
    await Promise.all(
      SHELL.map((url) => cache.add(new Request(url, { cache: "reload" })).catch(() => null)),
    );
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keep = new Set([CACHE_IMMUTABLE, CACHE_RUNTIME]);
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith("shanhe-") && !keep.has(key))
        .map((key) => caches.delete(key)),
    );
    await self.clients.claim();
    const clients = await self.clients.matchAll({ type: "window" });
    for (const client of clients) {
      client.postMessage({ type: "SW_ACTIVATED", version: VERSION });
    }
  })());
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  let url;
  try {
    url = new URL(request.url);
  } catch (_) {
    return;
  }
  if (!sameOrigin(url)) return;
  // Let the browser handle the SW script itself.
  if (url.pathname.endsWith("/sw.js")) return;

  if (isImmutable(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (isNetworkFirst(url) || request.mode === "navigate") {
    event.respondWith(networkFirst(request));
    return;
  }
  // 圖片等靜態檔：先網路，失敗再用快取
  event.respondWith(networkFirst(request));
});

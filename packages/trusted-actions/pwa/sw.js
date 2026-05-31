// TAI Approvals service worker.
const SW_BUILD = "__BUILD_ID__";
//
// SAFETY-CRITICAL:
//   The notification itself must NEVER be a one-tap approve. iOS doesn't
//   render notification action buttons at all, so on iOS a single tap
//   fires `notificationclick` with `action === ""` — if we mapped that
//   to the approve URL, a casual tap on the lock-screen banner would
//   silently authorize a real purchase. Instead, every tap opens the
//   PWA to a decide screen with explicit Approve / Reject buttons.
//
// The cleartext one-time tokens live in the URL hash so they:
//   - don't appear in HTTP referrer headers
//   - aren't sent to the server in any later request
//   - can be read client-side from `location.hash`

self.addEventListener("install", () => {
  // Activate immediately on update so users don't have to close and
  // reopen the PWA to pick up new code.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Let the page query "which SW build is actually controlling me?".
self.addEventListener("message", (event) => {
  if (event.data?.kind === "ping") {
    event.source?.postMessage({ kind: "pong", build: SW_BUILD });
  }
});

/**
 * Network-first for every same-origin GET. iOS installed-PWAs snapshot
 * HTML/JS/CSS at install time and serve from a hidden cache that
 * bypasses normal HTTP cache headers — without this fetch handler the
 * app would never pick up updates after install. We never cache here;
 * the executor is always online for the PWA to be useful at all, so
 * the fallback only matters for transient errors.
 */
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(req, { cache: "no-store" }).catch((err) => {
      // Last-ditch fallback so the SW doesn't break navigation while
      // the network is briefly unreachable.
      return new Response(`Offline: ${err.message}`, { status: 503 });
    }),
  );
});

self.addEventListener("push", (event) => {
  if (!event.data) {
    event.waitUntil(
      self.registration.showNotification("TAI", {
        body: "An action needs your approval.",
      }),
    );
    return;
  }

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "TAI", body: event.data.text() };
  }

  const title = payload.title || "Approval needed";
  const body = payload.body || "Tap to review and decide.";
  const data = payload.data || {};

  // No `actions` array — iOS doesn't render it, and even on Android we
  // route every tap through the PWA's decide screen so the security
  // model is identical across platforms.
  const options = {
    body,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: data.actionId || "tai-approval",
    requireInteraction: true,
    data,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

const DECIDE_CACHE = "decide-pending";
const DECIDE_KEY = "/__pending-decide";

self.addEventListener("notificationclick", (event) => {
  const { notification } = event;
  const data = notification.data || {};
  notification.close();

  const decide = {
    actionId: data.actionId || "",
    approveUrl: data.approveUrl || "",
    rejectUrl: data.rejectUrl || "",
    type: data.type || "",
    title: notification.title || "Approval needed",
    body: notification.body || "",
    productUrl: data.productUrl || "",
    ts: Date.now(),
  };

  // We hand the payload to the app three ways, each covering a case
  // the others don't:
  //  1. Cache API — survives a cold PWA launch, immune to iOS's
  //     habit of stripping URL hashes when launching from a
  //     notification. This is the PRIMARY path.
  //  2. postMessage — instant fast-path when the PWA is already open.
  //  3. URL fragment — last-resort fallback for browsers that don't
  //     give the SW Cache access.
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(DECIDE_CACHE);
        await cache.put(
          new Request(DECIDE_KEY),
          new Response(JSON.stringify(decide), {
            headers: { "Content-Type": "application/json" },
          }),
        );
      } catch {/* ignore: postMessage / hash still cover it */}

      const allClients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const c of allClients) {
        if ("focus" in c) {
          c.postMessage({ kind: "decide", payload: decide });
          return c.focus();
        }
      }
      // No client open — launch one. Append a sentinel so the page
      // KNOWS to look in the cache (avoiding a flash of the home
      // screen for users who happen to also have the PWA open).
      return self.clients.openWindow(`/?decide=1`);
    })(),
  );
});

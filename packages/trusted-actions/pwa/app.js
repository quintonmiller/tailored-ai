// TAI Approvals PWA — main app logic.
const APP_BUILD = (typeof window !== "undefined" && window.__APP_BUILD__) || "(unknown)";
//
// Responsibilities:
//  - Register the service worker (so we can receive Web Push)
//  - Subscribe to push using the executor's VAPID public key
//  - Persist the subscription on the executor (POST /push/subscribe)
//  - Render the list of pending actions (best-effort, public route)
//  - Provide an "Enable on this device" / "Disable" toggle

const $ = (sel) => document.querySelector(sel);

const els = {
  perm: $("#perm-status"),
  enable: $("#enable-btn"),
  disable: $("#disable-btn"),
  ua: $("#ua-warning"),
  swStatus: $("#sw-status"),
  pendingList: $("#pending-list"),
  pendingEmpty: $("#pending-empty"),
  statusCard: $("#status-card"),
  decideCard: $("#decide-card"),
  diagAppBuild: $("#diag-app-build"),
  diagSwBuild: $("#diag-sw-build"),
  diagSwState: $("#diag-sw-state"),
  diagCache: $("#diag-cache"),
  diagMsgs: $("#diag-msgs"),
  diagLast: $("#diag-last"),
  diagRefresh: $("#diag-refresh"),
  decideTitle: $("#decide-title"),
  decideBody: $("#decide-body"),
  decideId: $("#decide-id"),
  decideResult: $("#decide-result"),
  approveBtn: $("#approve-btn"),
  rejectBtn: $("#reject-btn"),
  decideDone: $("#decide-done"),
  historyStatus: $("#history-status"),
  historyList: $("#history-list"),
  historyMore: $("#history-more"),
};

// ---------- helpers ----------

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function isIOSStandalone() {
  return window.navigator.standalone === true;
}

function isIOSSafariMobile() {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
}

async function getRegistration() {
  if (!("serviceWorker" in navigator)) return null;
  return navigator.serviceWorker.ready.catch(() => null);
}

async function fetchVapidPublicKey() {
  const r = await fetch("/vapid/public-key");
  if (!r.ok) throw new Error(`VAPID key fetch failed: ${r.status}`);
  const j = await r.json();
  if (!j.publicKey) throw new Error("VAPID key missing");
  return j.publicKey;
}

async function postSubscription(sub) {
  const r = await fetch("/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sub.toJSON()),
  });
  if (r.status === 429) {
    throw new Error("Too many subscribe attempts. Try again in 10 minutes.");
  }
  if (!r.ok) throw new Error(`subscribe failed: ${r.status}`);
  return r.json();
}

async function fetchSubscriptionStatus(endpoint) {
  try {
    const r = await fetch("/push/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    });
    if (!r.ok) return "unknown";
    const j = await r.json();
    return j.status || "unknown";
  } catch {
    return "unknown";
  }
}

async function deleteSubscription(sub) {
  await fetch("/push/subscribe", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  });
}

// ---------- subscription flow ----------

async function subscribeFlow() {
  const reg = await getRegistration();
  if (!reg) throw new Error("Service worker not ready");
  const existing = await reg.pushManager.getSubscription();
  if (existing) {
    await postSubscription(existing);
    return existing;
  }
  // If permission was previously denied, requestPermission() short-
  // circuits and returns "denied" without prompting again. Tell the
  // user how to recover instead of leaving them stuck.
  if (Notification.permission === "denied") {
    throw new Error(
      "Notifications were previously denied. Re-enable: iOS → Settings → TAI Approvals → Notifications. Android → long-press app icon → App info → Notifications.",
    );
  }
  const perm = await Notification.requestPermission();
  if (perm !== "granted") {
    throw new Error(
      `Permission is "${perm}". Enable it in your phone's system settings, then tap Enable again.`,
    );
  }
  const publicKey = await fetchVapidPublicKey();
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  await postSubscription(sub);
  return sub;
}

async function unsubscribeFlow() {
  const reg = await getRegistration();
  if (!reg) return;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  await deleteSubscription(sub);
  await sub.unsubscribe();
}

// ---------- UI wiring ----------

async function refreshStatus() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    els.perm.textContent = "Web Push isn't supported in this browser.";
    els.enable.hidden = true;
    els.disable.hidden = true;
    return;
  }


  // iOS quirk: Web Push only works when launched from the home screen
  // (i.e. installed as a PWA).
  if (isIOSSafariMobile() && !isIOSStandalone()) {
    els.ua.hidden = false;
  }

  const reg = await getRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (sub) {
    // Safari keeps the push subscription at the origin level across PWA
    // reinstalls / clearing local state. Re-POST so the executor has
    // it; on first sync it'll be `pending` until the operator approves
    // via the TAI dashboard.
    try {
      await postSubscription(sub);
    } catch (err) {
      console.warn("re-sync postSubscription failed:", err);
    }
    const status = await fetchSubscriptionStatus(sub.endpoint);
    if (status === "pending") {
      els.perm.textContent =
        "Subscribed — waiting for operator approval in the TAI dashboard.";
    } else if (status === "active") {
      els.perm.textContent = `Subscribed and approved. Endpoint: …${sub.endpoint.slice(-24)}`;
    } else if (status === "rejected") {
      els.perm.textContent =
        "This device was rejected by the operator. Contact the operator to retry.";
    } else {
      els.perm.textContent = `Subscribed (status unknown). Endpoint: …${sub.endpoint.slice(-24)}`;
    }
    els.enable.hidden = true;
    els.disable.hidden = false;
  } else {
    els.perm.textContent = Notification.permission === "denied"
      ? "Notifications blocked. Enable them in browser settings."
      : "Not subscribed on this device.";
    els.enable.hidden = false;
    els.disable.hidden = true;
  }
}

async function refreshPending() {
  // Best-effort: there's no public list endpoint by design (action IDs
  // are not secrets but the approval token is). The list shown here is
  // a placeholder for future expansion; for now the source of truth is
  // the push notification itself.
  els.pendingEmpty.hidden = false;
  els.pendingList.innerHTML = "";
}

// ---------- decide screen (opened from a notification tap) ----------

const DECIDE_CACHE = "decide-pending";
const DECIDE_KEY = "/__pending-decide";

async function consumePendingDecide() {
  // Primary path: read the payload the SW stashed in the Cache.
  // Returns null if nothing pending (e.g. cold open without a notif).
  if (!("caches" in self)) return null;
  try {
    const cache = await caches.open(DECIDE_CACHE);
    const resp = await cache.match(DECIDE_KEY);
    if (!resp) return null;
    const decide = await resp.json().catch(() => null);
    await cache.delete(DECIDE_KEY);
    return decide;
  } catch {
    return null;
  }
}

function parseDecideHash() {
  // Fallback path for browsers where the Cache API isn't reachable
  // from the SW (rare). SW would write /#decide?a=...&p=... in that case.
  const hash = location.hash || "";
  if (!hash.startsWith("#decide?")) return null;
  const qs = hash.slice("#decide?".length);
  const p = new URLSearchParams(qs);
  return {
    actionId: p.get("a") || "",
    approveUrl: p.get("p") || "",
    rejectUrl: p.get("r") || "",
    type: p.get("t") || "",
    title: p.get("title") || "Approval needed",
    body: p.get("body") || "",
    productUrl: p.get("u") || "",
  };
}

async function postDecision(url) {
  if (!url) throw new Error("missing decision URL");
  const r = await fetch(url, { method: "POST" });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status}: ${txt.slice(0, 120) || "request failed"}`);
  }
  return r.json().catch(() => ({}));
}

function renderDecideTitle(title, productUrl) {
  // Default: plain text. If a productUrl is present and is http(s),
  // render the title as an anchor so the operator can open the listing
  // before approving.
  els.decideTitle.textContent = "";
  const safeTitle = title || "Approval needed";
  if (productUrl && /^https?:\/\//i.test(productUrl)) {
    const a = document.createElement("a");
    a.href = productUrl;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = safeTitle;
    els.decideTitle.appendChild(a);
  } else {
    els.decideTitle.textContent = safeTitle;
  }
}

function showDecideView(d) {
  els.statusCard.hidden = true;
  els.decideCard.hidden = false;
  renderDecideTitle(d.title, d.productUrl);
  els.decideBody.textContent = d.body || "(no details available)";
  els.decideId.textContent = d.actionId ? `Action: ${d.actionId}` : "";
  els.decideResult.hidden = true;
  els.decideResult.textContent = "";

  // Drop any listeners from a previous decide render by cloning each
  // button and replacing the original. Re-grab the references after.
  const freshApprove = els.approveBtn.cloneNode(true);
  const freshReject = els.rejectBtn.cloneNode(true);
  els.approveBtn.replaceWith(freshApprove);
  els.rejectBtn.replaceWith(freshReject);
  els.approveBtn = freshApprove;
  els.rejectBtn = freshReject;
  els.approveBtn.disabled = false;
  els.rejectBtn.disabled = false;

  const finish = (msg) => {
    els.approveBtn.disabled = true;
    els.rejectBtn.disabled = true;
    els.decideResult.hidden = false;
    els.decideResult.textContent = msg;
    els.decideDone.hidden = false;
    // Clear the hash so a reload doesn't re-prompt with stale tokens.
    history.replaceState(null, "", "/");
  };

  // Reset the Done button each render (it might still be visible from
  // a previous decide). cloneNode strips any prior listener.
  const freshDone = els.decideDone.cloneNode(true);
  els.decideDone.replaceWith(freshDone);
  els.decideDone = freshDone;
  els.decideDone.hidden = true;
  els.decideDone.addEventListener("click", () => {
    els.decideCard.hidden = true;
    els.statusCard.hidden = false;
    refreshStatus();
  });

  els.approveBtn.addEventListener("click", async () => {
    if (!confirm("Approve this action? This will run the purchase.")) return;
    els.approveBtn.disabled = true;
    els.rejectBtn.disabled = true;
    els.decideResult.hidden = false;
    els.decideResult.textContent = "Approving…";
    try {
      await postDecision(d.approveUrl);
      finish("✓ Approved. The executor is running the action now.");
    } catch (err) {
      els.decideResult.textContent = `Failed: ${err.message}`;
      els.approveBtn.disabled = false;
      els.rejectBtn.disabled = false;
    }
  });

  els.rejectBtn.addEventListener("click", async () => {
    els.approveBtn.disabled = true;
    els.rejectBtn.disabled = true;
    els.decideResult.hidden = false;
    els.decideResult.textContent = "Rejecting…";
    try {
      await postDecision(d.rejectUrl);
      finish("✓ Rejected. The action will not run.");
    } catch (err) {
      els.decideResult.textContent = `Failed: ${err.message}`;
      els.approveBtn.disabled = false;
      els.rejectBtn.disabled = false;
    }
  });
}

console.log("[module] top-of-file. APP_BUILD=", APP_BUILD);

async function init() {
  console.log("[init] BEGIN");
  if ("serviceWorker" in navigator) {
    try {
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      els.swStatus.textContent = `Service worker: active (${reg.active ? "running" : "installing"})`;
    } catch (err) {
      els.swStatus.textContent = `Service worker: failed — ${err.message}`;
    }
  } else {
    els.swStatus.textContent = "Service worker: unsupported";
  }

  els.enable.addEventListener("click", async () => {
    els.enable.disabled = true;
    try {
      await subscribeFlow();
      await refreshStatus();
    } catch (err) {
      els.perm.textContent = `Could not enable: ${err.message}`;
    } finally {
      els.enable.disabled = false;
    }
  });

  els.disable.addEventListener("click", async () => {
    els.disable.disabled = true;
    try {
      await unsubscribeFlow();
      await refreshStatus();
    } catch (err) {
      els.perm.textContent = `Could not disable: ${err.message}`;
    } finally {
      els.disable.disabled = false;
    }
  });

  // ─── diagnostics ──────────────────────────────────────────────
  let msgCount = 0;
  let swBuild = "(no SW)";
  console.log("[init] diagnostic block start. APP_BUILD=", APP_BUILD, "diagAppBuild=", els.diagAppBuild);
  if (!els.diagAppBuild) {
    console.error("[init] els.diagAppBuild is null! All els:", Object.keys(els).filter(k => !els[k]));
  } else {
    els.diagAppBuild.textContent = APP_BUILD;
    els.diagSwBuild.textContent = "querying…";
    console.log("[init] diagAppBuild.textContent =", els.diagAppBuild.textContent);
  }

  async function refreshDiagnostics() {
    els.diagAppBuild.textContent = APP_BUILD;
    els.diagSwBuild.textContent = swBuild;
    // SW state
    const reg = await getRegistration();
    if (reg) {
      const w = reg.active || reg.installing || reg.waiting;
      els.diagSwState.textContent =
        `${w?.state || "?"} | controller=${navigator.serviceWorker.controller ? "yes" : "no"}`;
    } else {
      els.diagSwState.textContent = "no registration";
    }
    // Cache decide presence
    if ("caches" in self) {
      try {
        const cache = await caches.open(DECIDE_CACHE);
        const r = await cache.match(DECIDE_KEY);
        els.diagCache.textContent = r ? "YES (a notif tap fired)" : "no";
      } catch (e) {
        els.diagCache.textContent = `error: ${e.message}`;
      }
    } else {
      els.diagCache.textContent = "no Cache API";
    }
  }

  // Arrival paths into the decide screen, in order of reliability:
  //  1. Cache — primary. SW wrote the payload there on notificationclick.
  //     Works on cold launches even when iOS strips URL hashes.
  //  2. postMessage — fast-path for an already-open PWA.
  //  3. URL hash — last-resort fallback.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event) => {
      msgCount += 1;
      els.diagMsgs.textContent = String(msgCount);
      els.diagLast.textContent = new Date().toISOString().slice(11, 19) + "Z";
      if (event.data?.kind === "pong") {
        swBuild = event.data.build || "(unknown)";
        els.diagSwBuild.textContent = swBuild;
      }
      if (event.data?.kind === "decide" && event.data.payload) {
        showDecideView(event.data.payload);
      }
    });
    // Ask the controlling SW for its build id.
    const askSw = () => {
      const sw = navigator.serviceWorker.controller;
      if (sw) sw.postMessage({ kind: "ping" });
    };
    askSw();
    // Re-check whenever the SW changes
    navigator.serviceWorker.addEventListener("controllerchange", askSw);
  }

  els.diagRefresh.addEventListener("click", refreshDiagnostics);

  const cached = await consumePendingDecide();
  if (cached) {
    showDecideView(cached);
    return;
  }

  const hashDecide = parseDecideHash();
  if (hashDecide) {
    showDecideView(hashDecide);
    return;
  }

  await refreshStatus();
  await refreshPending();
  await refreshDiagnostics();

  // Server fallback: ask the executor if any pending action is waiting
  // for this subscription. This is the only path that works on iOS when
  // notificationclick isn't dispatched to the SW.
  await checkServerPending();

  // Re-check whenever the PWA becomes visible (e.g. you tapped a
  // notification and iOS surfaced the app without firing the SW).
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      checkServerPending().catch(() => {});
    }
  });
}

async function checkServerPending() {
  try {
    const reg = await getRegistration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (!sub) return;
    const r = await fetch("/pending", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    if (!r.ok) return;
    const j = await r.json();
    if (j.pending && !els.decideCard.hidden) return; // already showing one
    if (j.pending) showDecideView(j.pending);
  } catch {/* ignore */}
}

// ---------- history (past purchases) ----------

let historyNextCursor = null;
let historyLoaded = false;

async function fetchHistory(before) {
  const reg = await getRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (!sub) return { entries: [], next: null, unsubscribed: true };
  const r = await fetch("/history", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: sub.endpoint, before, limit: 50 }),
  });
  if (!r.ok) throw new Error(`history fetch failed: ${r.status}`);
  return r.json();
}

function renderHistoryEntry(e) {
  const li = document.createElement("li");
  li.className = "history-entry";
  const badge = document.createElement("span");
  badge.className = `history-badge history-${e.status}`;
  badge.textContent = e.status;
  const titleEl = document.createElement("div");
  titleEl.className = "history-title";
  if (e.product_url) {
    const a = document.createElement("a");
    a.href = e.product_url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = e.title || e.type;
    titleEl.appendChild(a);
  } else {
    titleEl.textContent = e.title || e.type;
  }
  const meta = document.createElement("div");
  meta.className = "history-meta muted";
  const parts = [];
  if (typeof e.final_price === "number") parts.push(`$${e.final_price.toFixed(2)}`);
  if (e.decided_at) parts.push(new Date(e.decided_at).toLocaleString());
  if (e.order_id) {
    const orderHref = `https://www.amazon.com/gp/your-account/order-details?orderID=${encodeURIComponent(e.order_id)}`;
    parts.push(`<a href="${orderHref}" target="_blank" rel="noopener noreferrer">order ${escapeHtml(e.order_id)}</a>`);
  }
  if (e.error) parts.push(`error: ${escapeHtml(String(e.error).slice(0, 120))}`);
  meta.innerHTML = parts.join(" · ");

  li.appendChild(badge);
  li.appendChild(titleEl);
  li.appendChild(meta);
  return li;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function loadHistory(append) {
  if (!append) {
    els.historyList.innerHTML = "";
    historyNextCursor = null;
    historyLoaded = false;
  }
  els.historyStatus.textContent = "Loading…";
  els.historyStatus.hidden = false;
  els.historyMore.hidden = true;
  try {
    const j = await fetchHistory(append ? historyNextCursor : undefined);
    if (j.unsubscribed) {
      els.historyStatus.textContent = "Enable notifications to view past purchases.";
      return;
    }
    historyLoaded = true;
    historyNextCursor = j.next;
    if ((j.entries || []).length === 0 && els.historyList.children.length === 0) {
      els.historyStatus.textContent = "No past purchases yet.";
      els.historyStatus.hidden = false;
      return;
    }
    for (const e of j.entries || []) {
      els.historyList.appendChild(renderHistoryEntry(e));
    }
    els.historyStatus.hidden = true;
    els.historyMore.hidden = !j.next;
  } catch (err) {
    els.historyStatus.textContent = `Couldn't load history: ${err && err.message ? err.message : "error"}`;
    els.historyStatus.hidden = false;
  }
}

els.historyMore.addEventListener("click", () => {
  void loadHistory(true);
});

// Re-load history when the page becomes visible (a fresh purchase may
// have completed while the PWA was backgrounded).
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && historyLoaded) {
    void loadHistory(false);
  }
});

// Kick the first load after the rest of init() has run.
setTimeout(() => { void loadHistory(false); }, 500);

init();

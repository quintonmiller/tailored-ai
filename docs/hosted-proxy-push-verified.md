# Hosted Proxy: PWA Install + Web Push Verification

## Status: BLOCKED — PWA Infrastructure Not Yet Implemented

**Date:** 2025-05-22
**Verified by:** CORAL (code inspection), the owner (device test — pending)

## Prerequisite Check

The parent task references `ptask_39a7fbd5` (Notification fan-out: email + web push) as a prerequisite. While marked `done`, the actual PWA infrastructure is **not yet implemented**:

### Missing Components

| Component | Expected Location | Status |
|-----------|------------------|--------|
| PWA manifest (`manifest.json`) | `packages/ui/public/manifest.json` | ❌ Not present |
| Service worker (`sw.js`) | `packages/ui/public/sw.js` | ❌ Not present |
| Push channel in notify executor | `packages/core/src/workflows/executors/notify.ts` | ❌ Only `discord`, `email`, `log` channels exist |
| VAPID push server | `packages/core/src/channels/push.ts` | ❌ Not present |
| PWA subscription UI | `packages/ui/src/` (settings page) | ❌ Not present |
| `index.html` PWA meta tags | `packages/ui/index.html` | ❌ No theme-color, no manifest link, no apple-touch-icon |

### Current State of `notify.ts`

The `NotifyExecutor` class supports channels: `discord`, `email`, `log`.
No `push` channel exists. No VAPID key generation. No subscription management.

### Current State of `index.html`

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Tailored AI</title>
  </head>
```

Missing for PWA:
- `<link rel="manifest" href="/manifest.json">`
- `<meta name="theme-color">`
- `<link rel="apple-touch-icon">`
- `<meta name="apple-mobile-web-app-capable">`
- `<meta name="apple-mobile-web-app-status-bar-style">`

## Test Plan (To Execute Once PWA Infrastructure Exists)

### 1. PWA Manifest Fetch Through Proxy
- [ ] Navigate to proxied URL (e.g., `https://proxy.tailored-ai.app`)
- [ ] Fetch `/manifest.json` via browser devtools Network tab
- [ ] Verify `Content-Type: application/manifest+json` (not `text/plain` from proxy)
- [ ] Verify all required fields: `name`, `short_name`, `start_url`, `display`, `icons`

### 2. Service Worker Registration
- [ ] Open browser devtools → Application → Service Workers
- [ ] Verify service worker registered at proxied origin
- [ ] Verify `fetch` event handler is active
- [ ] Check no CORS/MIME errors in console

### 3. iOS Safari — Add to Home Screen
- [ ] Open proxied URL in Safari on iOS 16.4+
- [ ] Tap Share → "Add to Home Screen"
- [ ] Verify icon appears on home screen
- [ ] Launch from home screen (not Safari tab)
- [ ] Verify app loads in standalone mode (no Safari chrome)

### 4. Push Subscription (VAPID)
- [ ] From home-screen app, tap "Subscribe to Push"
- [ ] Accept notification permission prompt
- [ ] Verify subscription sent to server (check server logs)
- [ ] Verify VAPID public key served correctly through proxy

### 5. Test Notification Delivery
- [ ] Trigger a workflow with `notify` step (channel: push)
- [ ] Verify notification arrives on device while app is closed
- [ ] Verify notification contains both `notification` and `data` payload
- [ ] Tap notification → verify it opens dashboard to relevant page

### 6. Resubscribe Flow
- [ ] Unsubscribe from push
- [ ] Resubscribe
- [ ] Verify new subscription replaces old one on server
- [ ] Verify old subscription expires/cleans up

## iOS-Specific Gotchas

| Gotcha | Status |
|--------|--------|
| iOS 16.4+ required for web push | Documented — older iPhones won't work |
| Push only works for installed PWAs (not Safari tabs) | Must test from home screen |
| Notifications need both `notification` AND `data` payload | Verify in service worker |
| Each device subscription expires; resubscribe flow needed | Test unsubscribe → resubscribe |

## Android Test Results

| Test | Result |
|------|--------|
| PWA install via Chrome | N/A — PWA not implemented |
| Push notification delivery | N/A — PWA not implemented |

## Desktop Test Results

| Test | Result |
|------|--------|
| PWA install via Chrome | N/A — PWA not implemented |
| Push notification delivery | N/A — PWA not implemented |

## Conclusion

**Cannot verify** — the PWA + web-push pipeline referenced in `ptask_39a7fbd5` has not been implemented. A follow-up task is needed to build the infrastructure before this verification can proceed.

## Follow-Up Needed

See follow-up task for implementation of:
1. PWA manifest + service worker
2. VAPID push server + subscription management
3. Push channel in `notify` executor
4. PWA subscription UI in settings
5. `index.html` PWA meta tags

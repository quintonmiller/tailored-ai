---
"@tailored-ai/ui": patch
---

Restructure the bundled web UI for clarity: collapse the flat 14-link nav into
a three-tier structure (top-level Home / Chat / Tasks, plus accessible "Build"
and "System" disclosure groups), de-duplicate overlapping surfaces, and hide
debug internals behind per-item disclosures.

- Nav: three tiers with keyboard-reachable, hover/click dropdowns (aria-expanded).
- Merged the standalone Actions page into Approvals as a two-tab page; both
  `#/actions` and `#/approvals` still resolve.
- Config "Agents" now links to the standalone `#/agents` editor instead of a
  second editor; low-traffic config sections moved under a collapsed "Advanced"
  disclosure; removed the dead `profiles` alias.
- `#/tasks` (no id) redirects to `#/projects`; `#/tasks/:id` deep links remain.
- Home/Dashboard: dropped the Memory and Watchers sections (covered elsewhere),
  moved Logout into the nav, and extracted the inline mobile `<style>` block
  into the stylesheet.
- Memory note rows now lead with content + relative time + tags; IDs,
  importance, ref-counts, and Promote live behind a per-note details disclosure.
- Chat approval cards show a compact key/value arg list with raw JSON on demand
  instead of a raw JSON dump.

Bundled default UI (replaceable via the UI provider registry); structural
reorganization, no behavior change. All existing routes keep resolving.

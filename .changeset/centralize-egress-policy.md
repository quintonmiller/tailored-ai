---
"@tailored-ai/core": patch
---

**Security:** Centralized SSRF / outbound-HTTP egress policy at `packages/core/src/security/egress-policy.ts`. Applied to `web_fetch` and the workflow `http_request` step. By default, loopback, RFC1918, IPv6 ULA (fc00::/7), link-local (169.254/16, fe80::/10), carrier-grade NAT (100.64/10), unspecified, and cloud metadata endpoints (169.254.169.254, fd00:ec2::254, fe80::a9fe:a9fe) are denied. DNS is resolved before fetch so a hostname that resolves to a private IP gets caught — including the multi-A-record case where one leg is public and another is private. Operators opt back into internal targets via `security.egress.allowHosts` / `allowPrivateNetworks` / `allowMetadataEndpoints` in `config.yaml`, or turn the policy off entirely with `disabled: true` (loud `validateConfig` warning fires when set). Closes #57.

**Known limitation**: DNS-rebinding is not addressed (the policy resolves DNS, the fetch resolves separately). A follow-up will pin fetch to the resolved IP via a custom Undici dispatcher.

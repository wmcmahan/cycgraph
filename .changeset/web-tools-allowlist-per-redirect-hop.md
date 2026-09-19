---
"@cycgraph/tools": patch
---

`web_fetch` and `http_request` now re-check `allowedHosts` on every redirect hop and drop operator `defaultHeaders` (plus `authorization`, `cookie`, and `proxy-authorization`) once a hop changes origin, so an allowed host can no longer 302 configured credentials to another host. Requests that redirect off the allowlist fail with `HostNotAllowedError` instead of being followed.

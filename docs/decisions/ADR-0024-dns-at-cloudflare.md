# 0024 DNS at the owner's Cloudflare zone; DNS-only records added by hand

Status: accepted
Date: 2026-11-07

## Context
The owner's domains are on Cloudflare DNS and already host other services. v3 assumed a Route 53 hosted zone managed by the stack. The hostname is owner-specific and must not appear in the public repository.

## Decision
- `MA_DOMAIN` is the subdomain used as `{host}`. It lives in the owner's environment and local config only; examples use `memory.example.com`; CI greps committed files for it.
- The owner adds the records in Cloudflare by hand when `mema deploy` prints them: A `{host}` and A `admin.{host}` to the Elastic IP, both DNS only (never proxied), and CAA `0 issue "letsencrypt.org"` on the subdomain only. The apex and existing records are never touched, and the project holds no Cloudflare credential (a zone-scoped API token could edit every record in the zone, including the apex).
- Two A records instead of one: the admin UI needs its own origin for XSS and cookie isolation (auth-and-security.md §2). This is the one deviation from "one A record".
- Proxying is refused: it would end TLS at Cloudflare (tokens and memory visible to Cloudflare) and its 100-second timeout would cut long-lived MCP streams. `mema deploy`, `mema doctor` and an hourly check on the instance verify the records resolve to the Elastic IP itself.
- Teardown releases the Elastic IP only after public DNS stops resolving the deleted records. The accounturi CAA parameter is optional hardening, because every new instance creates a new ACME account.
- Route 53 remains an option (`--dns route53`) for other self-hosters.

## Consequences
Each spike or eval stack needs the owner to add and delete one or two records. The hostname appears in Certificate Transparency logs; it is not treated as a secret.

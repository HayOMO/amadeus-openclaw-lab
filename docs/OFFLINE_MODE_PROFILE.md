# Offline Mode Profile

This profile defines a future local-only assistant mode inspired by offline
personal assistant projects.

## Current Decision

Offline mode is a policy profile, not a guarantee that every model/tool is
available offline. It is useful only when the active model and selected tools
can run without network access.

## Allowed Use

Offline mode may:

- disable public web search, browser navigation, hosted image generation, and
  external APIs;
- prefer local notes, memory, prompt library, media transforms, and deterministic
  utilities;
- explain which requested operations need network access;
- provide a dry-run report of tools that would be blocked.

## Required Boundaries

Offline mode must:

- fail closed for network tools;
- avoid silent fallback to hosted providers;
- keep model availability explicit;
- preserve privacy and memory boundaries;
- mark generated answers as using local context only when sources are missing.

## Not Allowed

This profile does not allow:

- pretending an answer is current without network access;
- using cached web data as if it were fresh;
- bypassing public-network guards;
- changing global model/provider settings without explicit operator action.

## Test Requirements

Future offline-mode tooling must test:

- network tool blocking;
- local tool allowlist;
- stale/cached source labeling;
- model availability reporting;
- no hosted provider fallback when offline mode is active.

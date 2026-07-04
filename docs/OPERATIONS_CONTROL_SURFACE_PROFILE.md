# Operations Control Surface Profile

This profile covers future WebUI model management, an authenticated local HTTP
chat endpoint, and a web admin dashboard. It is a control-surface boundary, not
an enabled public service.

## Current Decision

The current bot stays chat-first and local-first. Any control surface must be
local or authenticated by default, must not expose secrets, and must not bypass
the Telegram trigger/window policy.

## Covered Candidates

- WebUI model management: view known model profiles and request a bounded model
  switch.
- HTTP chat API endpoint: accept a local authenticated request that is routed
  through the same transcript and trigger safeguards as chat.
- Web admin dashboard: read health/status/config summaries and offer explicit
  mutation plans for risky changes.

## Allowed Operations

A control surface may:

- list model profiles from the existing profile catalog;
- show active model/profile state;
- request a model switch through the existing `model_config` mutation plan;
- show recent sanitized tool failures and health checks;
- show public-export and config-validation status;
- create dry-run chat requests for replay/eval fixtures.

## Required Boundaries

A control surface must:

- bind to localhost by default;
- require authentication before reading or mutating state;
- redact tokens, local paths, private chat ids, cookies, and account names;
- log attempted mutations as explicit operator actions;
- use the existing model/profile catalog instead of arbitrary model names;
- keep chat endpoint input transcript-safe;
- reject unknown chats and cross-platform delivery targets;
- avoid public tunnels unless a separate deployment decision exists.

## Not Allowed

This profile does not allow:

- unauthenticated web dashboards;
- remote public admin panels;
- arbitrary shell/script execution;
- raw conversation database browsing;
- admin/moderation actions;
- automatic model changes based on untrusted user text;
- exposing local browser sessions or account cookies.

## Test Requirements

Before implementation is enabled, tests must cover:

- unauthenticated request rejection;
- localhost/default binding;
- token/path/chat-id redaction;
- model switch plan generation without immediate risky mutation;
- chat endpoint replay through the normal trigger/window policy;
- dashboard health output without private logs;
- public export contains docs/tests only, not secrets.

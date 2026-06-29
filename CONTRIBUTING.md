# Contributing

This project is maintained as one repository with two explicit layers:

1. OpenClaw compatibility: patches, patch contracts, apply/verify scripts, and
   tests that bridge gaps in the upstream OpenClaw runtime.
2. Agent tooling: local plugins, tool manuals, feature manifests, generated
   config, control surfaces, memory/search/tool policies, and product tests.

Keep changes inside the smallest layer that can own the behavior.

## Before Changing Code

- Read `docs/REPO_MAP.md`, `docs/IMAGEBOT_ARCHITECTURE.md`, and the relevant
  manual or plugin file.
- Read `docs/EXTENSION_PLAYBOOK.md` before adding a feature.
- Read `docs/PATCH_COMPATIBILITY.md` before touching runtime patches.
- Add or update `docs/ATTRIBUTION_AND_REFERENCES.md` when borrowing an idea,
  architecture pattern, protocol behavior, or implementation approach from a
  mature project.

## Layer Rules

- Do not put product features into OpenClaw runtime patches unless no public
  config/plugin/manual surface can express the behavior.
- Do not put compatibility workarounds into persona or prompt text.
- Tool descriptions and manuals must describe real capabilities and limits.
- Side effects belong in code gates, dry runs, review actions, owner checks,
  path allowlists, or rate limits.
- New memory behavior must state its scope and lifecycle.

## Tests

Use the smallest relevant test first, then widen based on blast radius:

```powershell
npm run lint:config
npm run health:features
npm run test:core
npm run test:all
npm run test:patches
```

Documentation-only changes normally need no runtime test, but public migration
work should still run at least `npm run lint:config` and `npm run
health:features` before publication.

## Do Not Commit

- bot tokens, provider keys, refresh tokens, cookies, sessions, or SSH keys;
- raw Telegram memory or exported private group memory;
- generated media, downloads, logs, local runtime state, or built binaries;
- vendored dependency directories such as `node_modules/`.

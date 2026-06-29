# Public Repository Plan

Target repository name for the first public migration:

```text
amadeus-openclaw-lab
```

The name is intentionally unofficial and can be renamed later.

## Public Posture

This should be one repository with two maintained layers:

1. OpenClaw compatibility layer.
2. Agent tooling layer.

The repository should read as a local-first integration lab, not as a hosted bot
service, scraping toolkit, or official OpenClaw distribution.

Public README wording should make these boundaries clear:

- unofficial OpenClaw compatibility and agent-tooling lab;
- no affiliation with OpenClaw unless upstream later says otherwise;
- users provide their own local credentials;
- no tokens, sessions, private memory, generated media, logs, or runtime state in
  the repository;
- no scheduled automation or hosted bot operation from GitHub Actions.

## Layer Map

| Layer | Current paths | Owner rule |
| --- | --- | --- |
| OpenClaw compatibility | `patches/openclaw-2026.6.10-runtime/`, `policy/runtime_patch_contract.json`, patch apply/export/verify scripts, patch tests. | Only bridge upstream OpenClaw gaps that cannot be expressed through config, plugins, manuals, hooks, or scripts. Every patch needs a protected behavior, test mapping, and retirement condition. |
| Agent tooling | `plugins/`, `tool_manuals/`, `features/`, `config/imagebot/`, `policy/agent_architecture_contract.json`, Telegram replay tests, control panel. | Product behavior, tools, memory, search, media, persona routing, and local UX live here. Use patches only when this layer cannot reach the host behavior safely. |
| Private/local overlays | `persona/`, local settings, memory, tokens, logs, generated media, runtime package state. | Before publication, expose examples/templates and keep private identity or group state outside the public repo. |
| Docs and governance | `docs/`, `SECURITY.md`, `CONTRIBUTING.md`, `NOTICE`, `LICENSE`. | Explain the layer boundary, borrowed references, safety posture, and test expectations. |

## Migration Strategy

Use a fresh public repository or an orphan public-history branch for the first
push. Do not push the old private history unless the full history has been
audited for secrets and private memory.

Initial migration checklist:

1. Finish `docs/ATTRIBUTION_AND_REFERENCES.md`.
2. Keep `LICENSE`, `NOTICE`, `SECURITY.md`, and `CONTRIBUTING.md`.
3. Replace private persona/group material with example overlays or document that
   those paths are local-only before the first public push.
4. Update README OpenClaw patch version references to 2026.6.10.
5. Run local checks:

```powershell
npm run lint:config
npm run health:features
npm run test:all
npm run test:patches
```

6. Run a full-history secret scan before pushing any retained history.
7. Create the new repo under the new GitHub account.
8. Push the curated public tree.

## GitHub Settings

Start conservatively:

- public repository, but with no deployment secrets;
- Issues, Discussions, Wiki, and Projects off until the baseline docs are stable;
- Actions enabled only for manual `workflow_dispatch`;
- workflow `permissions: contents: read`;
- Dependabot alerts, secret scanning, and push protection enabled where GitHub
  makes them available;
- no scheduled workflows until the new account has normal standing and the repo
  has a boring history of clean manual runs.

This follows GitHub's own repository best-practice guidance for README,
security features, and community files, while keeping automation minimal for a
new account.

## Public Feature Wording

Use careful labels:

- Mars forward detector: distinctive project feature, not a new algorithm.
- Two-layer social memory: project-specific engineering over mature memory
  patterns, not original research.
- Tool manual layer: local implementation of progressive-disclosure agent
  patterns.
- Runtime patch governance: compatibility discipline around OpenClaw updates.
- Sticker/media workbench: local Telegram workflow with dry runs, review gates,
  and managed-set boundaries.

Do not claim "original research" unless the repo includes a method definition,
baseline comparison, tests, and reproducible results.

## README Shape

The public README should be shorter than the private operator README:

1. What this is.
2. What this is not.
3. Two-layer architecture diagram or table.
4. Quick local setup.
5. Runtime patch workflow.
6. Safety and secret boundaries.
7. Feature highlights.
8. References and attribution link.

Private operator details can move into `docs/LOCAL_OPERATOR_GUIDE.md` later if
the README becomes too long.

## CI Shape

Keep the current manual workflow shape:

- Windows test suite.
- Patched OpenClaw runtime preparation in a temp runtime root.
- Config lint.
- Feature health.
- Full tests.
- Runtime patch verification.
- Secret scan job.

No push, pull_request, cron, release, package publish, or deployment workflows
for the first public baseline.

## Maintenance Reminder

Every future change should answer one question before code moves:

```text
Is this OpenClaw compatibility, or is this agent tooling?
```

If the answer is unclear, update docs first. That little pause is cheaper than
debugging a feature that leaks through runtime patches, prompts, plugins, and
manuals at the same time.

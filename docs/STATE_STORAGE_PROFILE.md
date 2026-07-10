# State Storage Profile

## Decision

The runtime honors OpenClaw's `OPENCLAW_STATE_DIR` across generated plugin
configuration, control-server paths, shared media paths, active plugin
fallbacks, and stateful maintenance scripts. The default remains
`%USERPROFILE%\.openclaw`.

No storage volume is created or formatted by this project. Storage used by the
Codex desktop application, including any third-party RAM-disk arrangement, is
outside the Amaduse runtime boundary.

## Migration Procedure

1. Stop the OpenClaw gateway and control server.
2. Copy `%USERPROFILE%\.openclaw` to an existing operator-selected destination.
3. Compare file counts and representative hashes before changing configuration.
4. Set `OPENCLAW_STATE_DIR` for every process that launches OpenClaw or the
   control server.
5. Run `npm run lint:config`, `npm run build:config`,
   `npm run verify:media`, and `npm run test:core` with that environment.
6. Keep the old tree read-only until live sessions, memory search, media tools,
   and Telegram delivery have all been observed successfully.

Example for an existing persistent volume mounted as `D:`:

```powershell
$env:OPENCLAW_STATE_DIR = "D:\OpenClawState"
npm run build:config
openclaw config validate
```

This repository does not persist a machine-wide environment variable or move
private runtime state automatically.

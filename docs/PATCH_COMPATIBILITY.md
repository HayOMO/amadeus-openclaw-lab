# Runtime Patch Compatibility

OpenClaw updates can replace the bundled files under `node_modules\openclaw\dist`. The Amaduse imagebot behavior depends on a small set of runtime patches, so this repo keeps those patches as first-class artifacts instead of relying on memory.

## Current Patch Set

The current runtime patch set is described by:

```text
patches\openclaw-2026.6.10-runtime\manifest.json
```

The manifest records:

- the OpenClaw version the patches were exported from;
- the patch file and target runtime file;
- the behavior each patch protects;
- the smoke tests that should cover it.

The ownership and retirement contract is tracked separately:

```text
policy\runtime_patch_contract.json
```

Every runtime patch must say which host surface it bridges, which public
plugin/config surfaces were checked first, why a runtime patch is still the
least-bad option, and when the patch should be retired. A patch without a
retirement condition is not accepted.

## Verify The Installed Runtime

Run this after an OpenClaw update, reinstall, or suspicious behavior:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\VERIFY_RUNTIME_PATCHES.ps1
```

Output meanings:

- `OK`: the installed runtime already contains that patch.
- `WARN`: the patch is not installed, but it still applies cleanly.
- `FAIL`: the installed runtime no longer matches the patch. Re-port or inspect manually before assuming imagebot behavior is intact.

Use strict mode when a CI-style non-zero exit is useful for unapplied patches:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\VERIFY_RUNTIME_PATCHES.ps1 -Strict
```

Run the governance check after adding or changing any runtime patch:

```powershell
node .\scripts\TEST_RUNTIME_PATCH_GOVERNANCE.mjs
```

## Patch Governance

Prefer these surfaces in order:

1. plugin code and documented hooks;
2. generated OpenClaw config;
3. tool manuals and model-visible contracts;
4. runtime patch only when the behavior is below the public extension boundary.

Runtime patches are acceptable only for OpenClaw 2026.6.10 gaps such as Telegram
channel pre-gate routing, built-in media delivery/schema behavior, provider
transport, or host transcript locking. If a newer OpenClaw version exposes a
stable SDK or config surface for the same behavior, migrate there instead of
carrying the patch forward.

The current highest-risk item is `telegram-imagebot-core`, because it groups
multiple Telegram/session concerns into one large runtime patch. Do not add new
unrelated behavior to that patch. Split or retire pieces as OpenClaw exposes
the needed Telegram and session contracts.

## CI Runtime Preparation

CI does not depend on a preinstalled desktop OpenClaw tree. The Windows workflow
sets `LOCALAPPDATA` to a runner temp directory, then runs:

```powershell
npm run prepare:runtime:ci
```

That script downloads the manifest OpenClaw version, applies every runtime
patch, and leaves the patched package at the normal WinGet-style runtime path
under the temp `LOCALAPPDATA`. Outside CI it refuses to prepare a non-temp
runtime root unless `--force` is passed.

## Apply Or Re-export

Apply the current patch set to the installed OpenClaw package:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\APPLY_RUNTIME_PATCHES.ps1
```

Re-export patches after intentionally editing the installed runtime:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\EXPORT_RUNTIME_PATCHES.ps1
```

After re-exporting, update the manifest if any patch file name, target file, protected behavior, or test coverage changed.

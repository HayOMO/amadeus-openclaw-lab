# Security Policy

## Scope

This repository is a local-first OpenClaw integration lab. It does not operate a
public bot service and should not contain secrets, session state, private
Telegram memory, generated media, or local browser profiles.

Security reports should focus on the reproducible repository contents:

- OpenClaw compatibility patches and patch application scripts.
- Local OpenClaw plugins and tool contracts.
- Generated configuration builders.
- Launcher/control-panel code.
- Tests, policies, and documentation that describe executable behavior.

## Reporting

Do not include tokens, private chat logs, browser cookies, personal access
tokens, SSH keys, or full private memory exports in a public issue.

Preferred reporting path after the GitHub repository is created:

1. Use GitHub private vulnerability reporting if it is enabled for the
   repository.
2. Otherwise open a minimal issue that describes the affected component and
   reproduction shape without secrets.
3. Share sensitive reproduction material only through a private channel agreed
   with the maintainer.

## Local Secrets

The repo expects secrets to live outside git, usually under `~/.openclaw` or
script-specific token files that match `.gitignore`. Before publishing or
opening a pull request, run:

```powershell
git status --short
npm run lint:config
npm run health:features
```

For a public migration or release candidate, also run the full test suite and a
history secret scan before pushing any history to GitHub.

## Actions Posture

GitHub Actions must stay conservative:

- no scheduled workflows until the repository has a clean public baseline;
- `workflow_dispatch` only for the initial public repo;
- minimal `GITHUB_TOKEN` permissions, normally `contents: read`;
- no repository secrets unless a documented workflow requires them.

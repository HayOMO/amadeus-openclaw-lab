# Bot Feature Scouting

This folder tracks feature ideas collected from popular public bot repositories.

## Notes

- `feature_candidates_2026-06-29.md`: broad bot feature scout.
- `telegram_chat_new_features_2026-06-30.md`: Telegram-chat backlog prototypes
  mapped to `chat_toolbox`.
- `script_micro_features_2026-07-02.md`: low-cost script/pre-model group
  features such as word clouds, message stats, quote cards, repeater variants,
  sticker statistics, and data-governance requirements.

## Process

1. Rank public bot repositories by visible GitHub topic/star pages when the
   GitHub API is reachable.
2. Record the source repository, evidence text, boundary decision, and local
   implementation status.
3. Implement only features that fit the current Telegram imagebot boundary.
4. Record conflicts instead of silently expanding authority.

Network note: on 2026-06-29 the local Windows shell could not complete a TLS
handshake to `api.github.com`, so the first batch uses browser-accessible
GitHub topic/repository pages plus a repeatable scouting script with fixture
support. The script can be rerun when API access is healthy:

```powershell
node scripts/SCOUT_GITHUB_BOT_FEATURES.mjs --repos 50 --features 50
```

## Verification

Run these checks after changing the candidate table or its implementation
profiles:

```powershell
node scripts/TEST_TELEGRAM_CHAT_NEW_FEATURES.mjs
node scripts/TEST_CHAT_TOOLBOX_PLUGIN.mjs
node scripts/TEST_BOT_FEATURE_CANDIDATES.mjs
node scripts/TEST_GITHUB_BOT_FEATURE_SCOUT.mjs
node scripts/TEST_BOT_FEATURE_PROFILES.mjs
node scripts/TEST_CHANNEL_ADAPTER_CONTRACT.mjs
node scripts/TEST_SERVERLESS_DEPLOYMENT_PROFILE.mjs
node scripts/TEST_AGENT_OPS_PLUGIN.mjs
```

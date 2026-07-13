# Decision Log

This file records bot architecture decisions that must survive context
compression and future refactors.

## 2026-06-23: Multimodal Routing Is a Runtime Contract

OpenAI/GPT native-vision sessions should not spend an extra image-understanding
pass for ordinary Telegram images. The expected flow is:

1. `media-understanding` records a skipped image decision because the active
   chat model supports vision.
2. The same current-turn image remains available as a native image block for the
   chat model.

`scripts/TEST_IMAGEBOT_MULTIMODAL_ROUTE.mjs` locks this behavior against the
installed OpenClaw runtime. If this test fails, the bot may either waste a tool
call or, worse, skip image understanding without actually passing the image to
the model.

## 2026-06-23: Search Routing Is Native-First, Zhihu-Aware

Do not force a global `tools.web.search.provider`.

Search routing:

1. Keep the current model/provider's native or hosted search route open when
   available, and keep `web_search` permitted where the active OpenClaw runtime
   uses that policy entry to activate provider-native search. Native/provider
   search can be configured without appearing as a normal catalog tool. Catalog
   invisibility is not a fallback condition. Treat native search as successful
   only when sources/citations or trace evidence show it ran.
2. Use the Zhihu OpenAPI tools as a first-class route for Zhihu, Chinese
   community, Chinese-web, hot-list, and answer/article lookup. They are not a
   last-resort fallback.
3. Use `explicit_web_text_search` only as a bounded generic fallback when native
   search and Zhihu are unavailable, insufficient, or the task explicitly needs a
   generic web result list.
4. Do not document DuckDuckGo or any other provider as the default unless the
   active config explicitly selects it.

Reason:

- OpenClaw's runtime has both managed `web_search` providers and native-provider
  search handling. It can suppress managed `web_search` when a provider-native
  search tool is active.
- OpenAI Responses API exposes hosted `web_search` as a model tool.
- A 2026-06-24 imagebot probe showed the configured
  `tools.web.search.openaiCodex` route suppresses the managed `web_search`
  tool, but an embedded `openclaw agent` run did not expose an observable native
  hosted search call when explicit search tools were disallowed. Therefore the
   prompt should prefer native search and fall back to explicit search tools only
   when the current model lacks it or an actual native attempt errors, is empty,
   or supplies insufficient evidence.
- DeepSeek supports OpenAI-compatible models in OpenClaw. If DeepSeek-native
  search is exposed through the current provider/config, integrate it as a
  native route without overriding other providers globally.

Regression guard:

- `scripts/TEST_IMAGEBOT_CONFIG_SOURCE.mjs` asserts that generated
  `tools.web.search` does not force a global provider and that policy permits
  `web_search` without pretending the provider-native surface must appear in
  the ordinary Tool Search catalog.

## 2026-06-23: Group Bot Performance Defaults

Current low-risk speed knobs:

- Telegram collect debounce: `250ms`.
- Default background jobs: `4`.
- Web background jobs: `6`.
- Media background jobs: `4`.
- Browser pool max pages: `6`.
- Main model reasoning setting: `medium` for the active GPT-5.5 balanced
  profile.

These are local throughput defaults, not semantic behavior rules.

## 2026-06-23: Image Generation Timeout Uses `imageGenerationModel`

`tools.media.image.timeoutSeconds` is for image/media understanding. It does
not control the `image_generate` provider request.

Image generation timeout must be configured at:

- `agents.defaults.imageGenerationModel.timeoutMs`

The current bot source sets:

- primary: `openai/gpt-image-2`
- fallbacks: `[]`
- timeout: `420000ms`

Reason:

- OpenClaw runtime schema documents this key as the default provider request
  timeout for `image_generate`.
- Runtime code reads `cfg.agents.defaults.imageGenerationModel.timeoutMs` when
  resolving image generation.
- Empty fallbacks preserve the intended behavior: on timeout, return the
  timeout/failure instead of silently downgrading through other image models.

Regression guard:

- `scripts/TEST_IMAGEBOT_CONFIG_SOURCE.mjs` asserts the generated config emits
  `agents.defaults.imageGenerationModel.timeoutMs = 420000` and
  `fallbacks = []`.

## 2026-06-23: Model Selection Has Persistent Local New-Window State

`/ammodel` must not only pin the current Telegram window. It also writes the
future-window default into a local mutable state file:

- `~/.openclaw/imagebot/model-state.json`

The repository file remains a deterministic seed:

- `config/imagebot/model-state.json`

Current default:

- profile: `balanced`
- model: `openai/gpt-5.5`
- reasoning: `medium`
- verbosity: `low`
- maxTokens: unset; use provider/OpenClaw defaults unless there is a specific incident requiring a temporary cap.

Reason:

- OpenClaw session overrides are window-local.
- New imagebot windows otherwise fall back to `agents.list[0].model`, which can
  drift after experiments.
- Keeping mutable model state outside the repository prevents ordinary Telegram
  model changes from dirtying the checkout.
- The config builder reads the local state before the tracked seed for runtime
  builds, while template/public builds can explicitly use the seed-only path.
- Keeping a tracked seed lets fresh checkouts and rebuilds start from a known
  default when no local state exists.

Regression guard:

- `scripts/TEST_IMAGEBOT_CONFIG_SOURCE.mjs` asserts the generated default model
  is `openai/gpt-5.5` with `medium` reasoning.
- `scripts/TEST_TELEGRAM_MEDIA_DELIVERY_PATCH.mjs` asserts the runtime patch
  reads local model state first, falls back to the tracked seed, and seeds new
  windows from it.

## 2026-07-03: Chat Model Fallback Is Window-Local

Imagebot chat model fallback uses the existing OpenClaw fallback chain instead
of switching global defaults. `config/imagebot/settings.json` defines
`modelFallbacks` as:

- `deepseek/deepseek-v4-flash`
- `deepseek/deepseek-v4-pro`

When GPT subscription/quota/rate-limit failure triggers fallback, the current
session may persist the successful fallback as an automatic window-local model
override. Later new windows still seed from `~/.openclaw/imagebot/model-state.json`
and therefore keep the user's selected `/ammodel` default.

Regression guard:

- `scripts/TEST_IMAGEBOT_MODEL_FALLBACK.mjs` checks that default-sourced session
  overrides keep fallback chains enabled while explicit user overrides do not.
- `scripts/TEST_TELEGRAM_AMMODEL_RUNTIME.mjs` checks that `/ammodel` session
  mirrors are marked as `default`, not `user`.

## 2026-06-23: Tool Manuals Are the Dynamic Tool Surface Index

`tool_manual_search` must discover valid `focus` ids from `tool_manuals/*.md`
front matter instead of carrying a hand-maintained enum. New manuals should
become searchable by focus as soon as the file is committed.

Reason:

- The visible tool surface changes faster than the core prompt should grow.
- A stale focus enum makes a real manual effectively invisible to tool callers.

Regression guard:

- `scripts/TEST_CREATIVE_OPS_PLUGIN.mjs` asserts recently added manuals such as
  `public_video`, `meme_tools`, `image_skills`, `sticker_pack`, and
  `turn_observer` are present in the discovered focus set.

## 2026-06-23: Gateway Restart Reports Final State Only

`RESTART_IMAGEBOT_GATEWAY.ps1` stops the old gateway with
`STOP_IMAGEBOT_GATEWAY.ps1 -Fast`, then starts the gateway normally. The stop
phase still waits for the listener/process to close, but it does not run a stale
`openclaw gateway status` probe while the gateway is intentionally down.

Regression guard:

- `scripts/TEST_REPO_HYGIENE.mjs` asserts restart uses the fast stop path.

## 2026-06-23: Root Node Entrypoints Are ESM

The repository declares `"type": "module"` in `package.json`, so root `.js`
entrypoints must use ESM imports. In particular:

- `imagebot-launcher.js`
- `imagebot-control-server.js`

Do not convert them back to CommonJS `require()` unless the files are renamed to
`.cjs` and every launcher/native/script reference is updated.

Regression guard:

- `scripts/TEST_REPO_HYGIENE.mjs` runs both entrypoints with `--self-test`.

## 2026-06-26: Local Control Panel Uses Token + Origin Boundaries

`imagebot-control-server.js` is a loopback-only desktop helper, but loopback is
not an authorization boundary. The control server now generates a high-entropy
token at startup, stores it under `.runtime`, and requires every `/api/*`
request to present it in `X-Imagebot-Control-Token` or a bearer header.

State-changing requests also require the expected local `Origin` and
`application/json`; the server rejects unexpected `Host` headers to reduce DNS
rebinding risk. `/api/status` returns a redacted status summary and does not
return the repo root, absolute log path, raw log tail, or raw warning/error
lines.

The launcher reads the token file and passes the token to the browser through a
URL hash fragment, which the frontend immediately stores in session storage and
removes from the visible URL. Do not move the token into a query string or into
static JavaScript.

Regression guard:

- `scripts/TEST_CONTROL_SERVER_AUTH.mjs` covers no-token, wrong token, wrong
  Host, bad Origin, non-JSON POST, encoded static path traversal, and status
  redaction.

## 2026-06-27: Mars URL Keys Exclude Source Footers

Mars-forward URL fingerprints are content evidence, not generic source metadata.
Repeated channel subscription/profile links and X/Twitter follow/share intent
links must not create duplicate records, because channel posts often reuse those
links as a footer across unrelated articles.

Keep exact source message, Telegram media id, article URL, and visual-hash
evidence. Filter source-channel `t.me/...` self links, Telegram profile/invite
links, and social follow/share intent links before creating canonical URL keys.

Regression guard:

- `scripts/TEST_TELEGRAM_MARS_FORWARD_DETECTOR.mjs` covers two different
  same-source channel posts with different article URLs and the same footer
  links; the second post must remain a first-seen record.

## 2026-06-23: Shared Interaction Helpers Stay Off Hot Runtime Paths First

The `/ammodel` Telegram button flow already has runtime-patch ownership checks
and regression coverage for "only the menu/window creator can use this callback".
Do not rewrite that hot path merely to share code.

Instead, introduce shared callback/session ownership helpers for future
deterministic menus and multi-step flows, then wire them into new plugin-level
features first. Runtime patch migration is only worth doing when there is a real
bug or when multiple runtime callback paths exist.

Regression guards:

- `scripts/TEST_IMAGEBOT_WINDOW_ROUTING.mjs` keeps `/ammodel` callback ownership
  behavior covered.
- `scripts/TEST_INTERACTION_SESSION_REGISTRY.mjs` covers the shared helper's
  creator/chat/window/expiry checks.
- `scripts/REPLAY_TELEGRAM_SCENARIOS.mjs` covers multi-step interaction
  contracts without booting the gateway.

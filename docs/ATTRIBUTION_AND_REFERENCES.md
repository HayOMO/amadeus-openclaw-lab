# Attribution And References

This file separates upstream dependencies, design references, and local project
claims. It is intentionally conservative: unless a row says otherwise, the
project borrowed architecture ideas or product patterns, not source code.

## Star Shortlist

Projects worth starring from the research trail:

- OpenClaw: https://github.com/openclaw/openclaw
- OpenHands extensions: https://github.com/openhands/extensions
- OpenHands Software Agent SDK:
  https://github.com/OpenHands/software-agent-sdk
- Cline: https://github.com/cline/cline
- AstrBot: https://github.com/AstrBotDevs/AstrBot
- Koishi: https://github.com/koishijs/koishi
- Red DiscordBot: https://github.com/Cog-Creators/Red-DiscordBot
- grammY: https://github.com/grammyjs/grammY
- python-telegram-bot:
  https://github.com/python-telegram-bot/python-telegram-bot
- Botium: https://github.com/codeforequity-at/botium-core
- TestMyBot: https://github.com/pdesgarets/testmybot
- RAGFlow: https://github.com/infiniflow/ragflow
- Mem0: https://github.com/mem0ai/mem0
- Zep: https://github.com/getzep/zep
- tsticker: https://github.com/sudoskys/tsticker
- sticker-convert: https://github.com/laggykiller/sticker-convert

Documentation-only references that still matter:

- OpenClaw tool policy and sender-scoped tool restrictions:
  https://docs.openclaw.ai/gateway/config-tools
- OpenAI image API docs:
  https://developers.openai.com/cookbook/examples/multimodal/image-gen-models-prompting-guide
- OpenAI image generation API guide:
  https://developers.openai.com/api/docs/guides/image-generation
- Chinese and Asian image-prompt community references:
  https://cloud.tencent.com/developer/article/2671009
  https://aibook.ren/archives/ai-use-prompt-for-xiaohongshu
  https://youmind.com/zh-CN/skills/xiaohongshu-cover-generator-KLJOoeDLiEZVD9
  https://www.woshipm.com/ai/6305723.html
  https://www.liblib.art/tutorial/1
  https://iworldt.tistory.com/326
  https://newneek.co/@dalpha/article/16526
  https://note.com/guriham_lab/n/n98eb76678b91
  https://nijijourney.com/ja/blog/niji-7-prompting
  https://docs.novelai.net/ja/image/tutorial-charactercreation/
- InvokeAI, Hugging Face Diffusers, and Midjourney public prompting docs:
  https://invoke.ai/concepts/prompting-guide/
  https://huggingface.co/docs/diffusers/en/using-diffusers/weighted_prompts
  https://docs.midjourney.com/hc/en-us/articles/33329261836941-Getting-Started-Guide
- Harvard data visualization accessibility guide:
  https://accessibility.huit.harvard.edu/data-viz-charts-graphs
- GitHub repository best practices:
  https://docs.github.com/en/repositories/creating-and-managing-repositories/best-practices-for-repositories
- GitHub community profile files:
  https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/about-community-profiles-for-public-repositories
- GitHub Actions secure use:
  https://docs.github.com/en/actions/reference/security/secure-use
- Telegram Bot API: https://core.telegram.org/bots/api
- Telegram bot features: https://core.telegram.org/bots/features

## AI Assistance

This repository is developed with AI assistance, including OpenAI Codex for code
review, documentation drafting, implementation planning, and local maintenance
tasks. Codex is treated as a development assistant, not as a legal copyright
holder or independent maintainer. The human maintainer is responsible for
reviewing, testing, accepting, and publishing changes.

## Upstream And Dependency Attribution

| Component | Relationship | Notes |
| --- | --- | --- |
| OpenClaw | Upstream runtime and compatibility target. | Runtime patches target the OpenClaw package version recorded in the patch manifest. The OpenClaw 2026.6.10 npm package declares MIT license metadata. |
| Node.js / npm dependencies | Package dependencies. | Dependency licenses are governed by each dependency package. Do not vendor `node_modules/` into the repository. |
| Telegram Bot API | Platform contract. | Telegram command, sticker, file, and message behavior should follow official Bot API limits. |
| Provider APIs | Optional local runtime integrations. | Users provide their own local credentials. Do not commit provider secrets. |

## Borrowed Pattern Matrix

| Local area | Borrowed or referenced pattern | Local implementation claim |
| --- | --- | --- |
| Repository hygiene | GitHub README, license, citation, security, secret scanning, and conservative Actions guidance. | Standard open-source hygiene, not a project innovation. |
| OpenClaw compatibility layer | Patch governance and compatibility-shim discipline from normal downstream runtime maintenance. | Local patch set, manifest, retirement contract, and tests are project-specific engineering. |
| Sender-scoped tool policy | OpenClaw `tools.allow`, `tools.deny`, and `tools.toolsBySender` configuration. | Local operator-only tool list and generated global/agent policy are project-specific deployment hardening. |
| Plugin/tool/manual layout | OpenHands extensions and plugin packaging separate skills, hooks, tools, agents, commands, manifests, and docs. Cline separates runtime-agnostic agent loop primitives from host-specific tools and persistence. | Local OpenClaw plugins, tool manuals, allowed-tool config, and feature health checks are project-specific. |
| Image generation prompt recipes | OpenAI image docs; public Hugging Face Diffusers, Midjourney, Niji, and NovelAI guidance; Chinese/Asian community references for 小红书/抖音/公众号 covers, Korean/Japanese social portraits, guofeng/hanfu boards, and anime tag ordering. | Local prompt-library cards are rewritten, short on-demand recipes for the imagebot workflow; broad universal prompt/template cards are intentionally avoided to reduce style drift. Community/social-media sources are treated as trend signals, not authoritative standards. |
| Bot plugin surface | Koishi, AstrBot, and Red show plugin catalogs, consoles, permissions, and hot-reload or module discipline as mature bot patterns. | Local feature health and control-panel checks are a small, private-deployment version of that pattern. |
| Multi-step Telegram workflows | grammY conversations and python-telegram-bot ConversationHandler make state, owner, chat/user scope, fallback, persistence, and timeout explicit. | Local callback/session ownership and Telegram scenario replay follow the same engineering shape. |
| Telegram inline menu UX | Telegram Bot API inline keyboards/callback queries, grammY menu, Telegraf Markup, and python-telegram-bot examples use compact buttons, paging, callback answers, and message edits for deterministic controls. | Local `interaction_pipeline action=ui_plan` creates conservative keyboard plans and owner-scoped callback records; runtime message sending remains separate. |
| Rate limits and abuse bounds | grammY rate-limit/flood-control ecosystem treats resource protection as middleware. | Local quota and cooldown plans belong in plugins/policy, not in prompt text. |
| Conversation regression tests | Botium and TestMyBot frame chatbot behavior as replayable scenario tests. | Local `tests/telegram-scenarios` and replay scripts are project-specific fixtures. |
| Source-traceable knowledge replies | RAGFlow treats RAG answers as source-bearing context. | Local `knowledge_search` and related tools expose safe source blocks when appropriate. |
| Memory architecture | LangGraph/LangMem, Letta/MemGPT, GitHub Copilot Memory, Zep, and Mem0 all separate small working memory, retrieved long-term memory, episodes/facts, and validated shared context. | The two-layer social memory, recall gate, and curator are local engineering, not an original memory algorithm. |
| Sticker/media workflow | Telegram Bot API, tsticker, sticker-convert, and common local media pipelines. | Local sticker workbench adds dry-run, review, managed-set registry, and bot-permission boundaries. |
| Browser/account boundary | Mature agent systems separate tools, workspace, runtime state, and untrusted page content. | Local browser/account tools are bounded adapters and manuals, not general account automation. |

## Feature Claim Standard

Use these labels in public docs:

- `Upstream compatibility`: a behavior exists to keep this deployment working
  with OpenClaw and should move upstream or retire when OpenClaw exposes a stable
  surface.
- `Borrowed mature pattern`: a known pattern from mature bot or agent projects.
  Give references and do not imply novelty.
- `Project-specific engineering`: local implementation, glue, tests, UX, and
  policy boundaries are substantial but not a new research claim.
- `Distinctive feature`: a useful product behavior that is uncommon in this
  exact combination. It can be a repository highlight, but should still cite
  prior patterns.
- `Original research`: do not use this label unless there is a formal method,
  comparison, and reproducible evidence.

## Current Distinctive Features

| Feature | Public claim | Why this wording is safe |
| --- | --- | --- |
| Mars forward detector | Distinctive project feature. | It combines Telegram channel-forward fingerprints, canonical URL filtering, Telegram media ids, bounded local media evidence, conservative visual-hash candidates, same-group lookup, and optional first-message forwarding. The primitives are standard; the product integration is local. |
| Two-layer social memory | Project-specific engineering. | User/group/window memory, recall gate, and curator fit mature memory patterns. The value is practical continuity and debuggability, not algorithmic novelty. |
| Patch governance | Project-specific engineering. | Versioned patch manifest, runtime patch contract, retirement conditions, and tests make compatibility work explicit. |
| Tool-manual layer | Borrowed mature pattern plus local implementation. | Progressive disclosure and skills/manuals are known agent patterns; this repo maps them into OpenClaw tool manuals and feature health checks. |
| Conservative Telegram group gating | Project-specific engineering. | Group trigger, mention, reply-session, and window-routing policy protect a small trusted deployment. |

## Maintenance Rule

When adding or changing a feature, update this file if the change:

- adds a new external project reference;
- copies or adapts a nontrivial design pattern;
- changes whether a feature is merely borrowed, project-specific, or distinctive;
- introduces a new upstream compatibility patch.

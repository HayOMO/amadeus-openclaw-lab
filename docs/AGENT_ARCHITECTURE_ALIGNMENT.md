# Agent Architecture Alignment

This is the durable design anchor for Amaduse Imagebot. Read it before changing
prompts, tools, manuals, memory, workflow orchestration, or Telegram-facing
feature behavior.

The goal is not to copy any framework wholesale. The goal is to keep this
project aligned with mature agent patterns so future fixes do not drift into
prompt patches that hide capabilities or change the product boundary by
accident.

## References Checked

- Anthropic Agent Skills:
  https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
- Claude Agent Skills docs:
  https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
- OpenAI Agents SDK guide:
  https://developers.openai.com/api/docs/guides/agents
- OpenAI Agents SDK guardrails:
  https://openai.github.io/openai-agents-python/guardrails/
- OpenAI Agents SDK tracing:
  https://openai.github.io/openai-agents-python/tracing/
- MCP tools spec:
  https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- LangGraph persistence:
  https://docs.langchain.com/oss/python/langgraph/persistence
- LangGraph interrupts:
  https://docs.langchain.com/oss/python/langgraph/interrupts
- LangChain human-in-the-loop:
  https://docs.langchain.com/oss/python/langchain/human-in-the-loop
- OpenHands Software Agent SDK:
  https://github.com/OpenHands/software-agent-sdk
- AutoGPT / Forge / benchmark docs:
  https://github.com/Significant-Gravitas/AutoGPT
- GitHub Copilot agentic memory article:
  https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/
- Lightweight git-backed memory discussion:
  https://github.com/mem0ai/mem0/discussions/4051

## Mature Pattern Map

| Pattern | Mature implementation signal | Local mapping |
| --- | --- | --- |
| Progressive Disclosure | Skills expose short metadata first, then load full instructions and extra resources only when relevant. | `config/imagebot/prompt/30-tool-index.md` gives a short index. OpenClaw `tools.toolSearch` runs in `directory` mode so most heavyweight tool schemas are deferred behind `tool_search`, `tool_describe`, and `tool_call`. `tool_manual_search` and `tool_manuals/*.md` hold detailed usage. |
| Honest Tool Contracts | MCP-style tools expose names, descriptions, schemas, and structured results. The tool does what the contract says. | Plugin manifests, `settings.allowedTools`, schemas, focused manuals, and tests must stay in sync. |
| Capability Is Not Policy | Guardrails and approvals wrap execution; they do not pretend a tool does not exist. | Do not hide capability to fix model misuse. Fix action names, tool descriptions, manuals, dry-run/approval paths, and tests. |
| Side Effects Live In Code | Sensitive tool calls need deterministic checks before/after execution. | Permission checks, `dryRun`, `directImportApproved`, owner checks, path bounds, and rate/risk checks belong in plugins/scripts/runtime patches. |
| Stateful Workflows | Production agents persist thread/run state and can pause/resume long or reviewed actions. | Use background jobs, drafts, review actions, replay fixtures, and visible status messages for multi-turn or long-running Telegram work. |
| Human Review | HITL systems pause at defined actions and resume from saved state. | Review surfaces must be explicit actions such as `review_draft`, not implied by a prompt sentence. |
| Observability | Mature SDKs trace LLM generations, tool calls, guardrails, handoffs, and workflow spans. | Use `turn_observer`, feature health, replay fixtures, logs, and failure memory before adding more prompt prose. |
| Memory With Validity | Memory systems need scope, freshness, conflict handling, and deletion/forgetting rules. | Use `docs/MEMORY_ARCHITECTURE.md`; classify memory as semantic, episodic, procedural, or operational before adding storage. |
| Sandbox / Workspace Boundary | OpenHands-style agents separate agent, tools, workspace/runtime, and event observations. | Keep local desktop/browser/account tools bounded by named adapter actions. Do not expose raw shell or unconstrained UI primitives to the bot. |
| Benchmarks And Replays | Agent projects use benchmarks/replays to avoid subjective regressions. | Add tests or `tests/telegram-scenarios` fixtures when fixing recurring behavior. |

## Local Architecture Contract

1. Global prompt is a compact index, not the source of detailed procedure.
2. Tool descriptions are capability labels and parameter contracts.
3. Tool manuals are on-demand instructions for nontrivial usage.
4. Plugins/scripts own deterministic behavior and local state.
5. Runtime patches only bridge OpenClaw/Telegram behavior that config or plugins
   cannot express.
6. Memory must have scope and lifecycle rules before new facts are written.
7. Any side effect that can publish, delete, import, message, edit, browse with an
   account, or control a local app needs an executable gate in code.
8. Fixes must preserve the model's ability boundary unless the product boundary
   intentionally changes and the change is documented.

## Anti-Drift Rules

### Do Not Hide Capability

If the model misuses a tool, do not remove that tool from the visible capability
surface unless the product boundary really changed.

Prefer this order:

1. Rename or split ambiguous tool actions.
2. Make the tool description more honest and less directive.
3. Move detailed workflow text into the manual.
4. Add dry-run, review, ownership, or confirmation gates in code.
5. Add a replay/test that captures the failure.
6. Only then consider narrowing exposure, and document why.

### Do Not Teach The Model To Do The Whole Job In The Tool Index

The short index answers: "what capability exists?"

The manual answers: "how do I use it well?"

The plugin answers: "what actually happens, and what is allowed?"

When these are mixed together, the model starts following the index as a script.
That is how a sticker source-inspection tool turns into "copy a public pack and
publish it" even when the user asked for a themed creation workflow.

### Side Effects Must Be Idempotent Or Gated

Before a tool publishes, imports, deletes, writes, posts, controls an app, or
uses a logged-in browser session, code must make the requested operation
observable and bounded.

Good surfaces:

- `dryRun: true`
- `review_draft`
- `directImportApproved`
- owner/session checks
- path allowlists
- explicit dedicated-versus-isolated browser profile selection
- resumable background jobs

Weak surfaces:

- "Please be careful" in prompt text
- hidden negative instructions
- manual-only approval language for a tool that can already side-effect

### Browser And Account Tools Treat Pages As Untrusted

Browser-collected text can contain prompt injection. Browser/account tools must
return evidence and metadata; they should not inject page instructions as trusted
system guidance.

For Chinese image/resource collection, expose source-site hints and the two
browser profile capabilities without prescribing a fixed sequence. Do not make
a platform-specific crawler unless the user explicitly asks for that product
boundary.

### Memory Is Not A Dump

Memory writes should say which layer they belong to:

- semantic: stable facts, preferences, names, group lore
- episodic: useful past events and experiments
- procedural: reusable methods, tool usage lessons, source-site hints
- operational: repo/runtime state, failures, config gotchas

If a memory can go stale, record freshness or provenance. If it was learned from
one branch, one chat, or one failed experiment, keep that boundary visible.

## Current Local Status

Already aligned:

- `policy/agent_architecture_contract.json` records the action-level contract
  for high-risk tools, and `scripts/TEST_AGENT_ARCHITECTURE_CONTRACT.mjs`
  checks real schemas, manuals, source evidence, memory/browser boundaries, and
  trace/eval assets. `docs/AGENT_ARCHITECTURE_AUDIT.md` records the current
  pass/fail audit matrix and remaining gaps.
- `tool_manual_search` implements the project-local skill/manual layer.
- OpenClaw `tools.toolSearch` is enabled in `directory` mode, keeping the full
  allowed tool surface available while reducing the provider-visible schema set.
- Tool manuals cover search, browser profiles, sticker workbench, memory/persona,
  Telegram delivery, media understanding, and background jobs.
- `CHECK_IMAGEBOT_FEATURE_HEALTH.mjs` validates plugin/manual/test alignment.
- `turn_observer` and feature health give basic observability.
- Background jobs exist for long-running work.
- Sticker workbench now exposes source search, draft review, import/copy,
  managed target registry, add-from-sticker, and publishing actions instead of
  hiding the capability surface.
- Memory has a documented two-layer plus recall-gate shape in
  `docs/MEMORY_ARCHITECTURE.md`.

Gaps to fix over time:

- Feature health checks local coverage, but not all architecture rules in this
  document.
- Telegram replay fixtures are still thin for multi-turn sticker, memory, and
  browser/account workflows.
- Tool manuals can still become too directive if they include product decisions
  instead of usage contracts.
- Long-running background jobs need more end-to-end replay coverage.
- Memory needs stronger active-curation mechanics, especially conflict and
  freshness handling.

## Change Checklist

Before modifying a capability:

1. Read this file, `docs/EXTENSION_PLAYBOOK.md`, and the relevant manual/plugin.
2. Identify the owner surface: prompt, manual, plugin, feature, command,
   background job, runtime patch, memory, or docs.
3. State whether the change alters capability, policy, workflow, or wording.
4. Keep global prompt changes small.
5. Keep tool schema and description honest.
6. Put deterministic checks in code.
7. Add or update a focused test or replay fixture.
8. Run `npm run health:features` for tool/plugin/manual changes.
9. Run the smallest relevant test first, then the broader suite required by the
   blast radius.
10. Leave durable docs when a design decision would otherwise live only in chat.

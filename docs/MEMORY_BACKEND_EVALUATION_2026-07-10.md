# Memory Backend Evaluation - 2026-07-10

## Decision

Keep `imagebot-memory-search` as the active social-memory backend for this
iteration. Do not install Honcho or replace the scoped Telegram memory with
OpenClaw builtin memory yet.

The decision is based on scope correctness first, then latency and operational
cost. The current backend already separates user, group, and window memories;
persona profiles share that substrate without creating parallel memory silos.

## Current Dataset And Benchmark

Measured on 2026-07-10 against the live local imagebot memory:

- 531 Markdown files, 534 files total, about 8.8 MB.
- 714 semantic chunks in `semantic-index.json`.
- Embedding model:
  `Xenova/paraphrase-multilingual-MiniLM-L12-v2`.
- Foreground prewarm command: `npm run prewarm:memory`.
- Prewarm duration: 54.25 seconds with the existing model cache.
- Warm query sample (`count=5`, query text not included in this report):
  keyword 67.8 ms, semantic 1366 ms on first model use, hybrid 83.8 ms after
  model/index warmup.

The production startup already has an explicit prewarm surface. Warm hybrid
latency is small relative to a model turn, so a service migration is not
justified by current query latency.

## OpenClaw Builtin Memory

OpenClaw builtin memory is the preferred default for ordinary single-agent
workspace memory. It provides SQLite FTS5/BM25, vector search, hybrid merging,
CJK trigram support, file watching, and bounded WAL maintenance without an
extra database service:
https://docs.openclaw.ai/concepts/memory-builtin

It is not a drop-in replacement for this bot's social memory. The current
Telegram product contract requires query-time separation of per-user facts,
group lore, and window episodes. Indexing all current paths into one ordinary
workspace memory index would weaken that boundary unless separate agents,
collections, or an equivalent scope filter were added.

OpenClaw active memory can run a blocking recall sub-agent with concrete memory
tools, but that directly adds reply-path latency and defaults mainly to direct
chats. The current recall gate is a cheap routing hint and leaves retrieval as
an observable tool call:
https://docs.openclaw.ai/concepts/active-memory

## Honcho

Honcho provides workspaces, peers, sessions, messages, asynchronous derivation,
peer representations, semantic search, and parent/child agent awareness. Its
official OpenClaw integration persists conversations and exposes context,
conclusion search, message search, session history, and LLM-backed questions:
https://docs.openclaw.ai/concepts/memory-honcho

Those capabilities are useful when automatic user modeling and cross-session
multi-agent context become product requirements. They also add a plugin,
service boundary, background derivation, storage migration, and potentially
additional model calls. Automatic user modeling needs an explicit privacy and
retention decision for a private Telegram group.

The Honcho server architecture uses synchronous storage plus asynchronous
insight workers over workspace/peer/session/message primitives:
https://github.com/plastic-labs/honcho

## Acceptance Criteria For A Future Migration

A replacement must pass all of these before becoming the default:

1. User A cannot retrieve User B private memory through an unscoped query.
2. Group-shared lore is available to authorized group sessions without leaking
   to unrelated chats.
3. Window episodes retain provenance, freshness, and deletion behavior.
4. Persona switches preserve the same social memory identity.
5. Exact-name and error-string recall remains available alongside semantic
   recall.
6. Warm p95 retrieval stays below 500 ms for ordinary hybrid queries, or the
   user-visible quality gain justifies and documents the added latency.
7. Index/derivation failures degrade to keyword recall or a visible memory
   unavailable state without blocking the main response.
8. Migration is non-destructive and has a tested rollback path.
9. Storage location honors `OPENCLAW_STATE_DIR`.
10. Recall quality is compared on a fixed, anonymized suite covering aliases,
    old group jokes, preference updates, contradictions, and stale facts.

## Next Trigger

Re-evaluate Honcho or OpenClaw builtin/QMD memory when one of these becomes
true: scoped recall quality is measurably poor, the memory corpus grows by an
order of magnitude, multi-agent delegation ships, conflict/freshness handling
becomes a frequent failure, or automatic user representations become an
explicit product feature.

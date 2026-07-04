---
id: knowledge_library
tools: knowledge, knowledge_ingest, memory_search, persona_search
keywords: knowledge library, RAG, semantic search, local notes, docs, prompt library, persona library, memory registry, 资料库, 知识库, 本地资料, 语义检索
when_to_read: Before looking across persona notes, prompt library, tool manuals, memory, artifacts, or user-ingested local notes.
---

# Knowledge Library

## Purpose

`knowledge action=search` is a lightweight RAG-style registry over:

- persona notes;
- prompt library;
- tool manuals;
- bot memory files;
- user-ingested notes/files.

It complements specialized tools. Use `memory_search` for detailed user/group memory, and `persona_search` for character/profile material.

## Search Contract

Use `knowledge action=search` when the source is broad or unclear.

Parameters:

- `query`: what to find.
- `sources`: optional comma-separated source ids or kinds, such as `persona`, `prompt_library`, `tool_manuals`, `memory`, or `user_docs`.
- `count`: max results.
- `mode`: `hybrid` by default; `keyword` for exact fast lookup; `semantic` when wording may differ and you are willing to wait for the embedding index.
- `fresh`: in hybrid mode, wait for a fresh semantic index instead of using keyword results while the index warms.

Hybrid mode returns keyword results immediately and uses the local semantic index when available. If the semantic index is cold, it warms in the background and the result says so.

## Ingest

Use `knowledge_ingest` for user-supplied notes or bot-local text files that should become searchable later.

Accepted input:

- direct `text` / `content`;
- bot-local text files from allowed ingest roots.

It does not ingest arbitrary local paths or external URLs.

Runtime ingest is two-step:

- `action:draft` (default): validate the text/file and create a scoped draft
  plan. It does not write to `user_docs`.
- `action:commit`: persist a draft after the original requester sends the
  returned approval code in a later message. The commit is bound to the original
  chat/session/window and sender.
- `action:list`: list ingested records visible to the current scope.
- `action:delete`: dry-run by default; `dryRun:false` deletes a visible
  ingested record in the current scope and records an audited delete tombstone.
  The model may manage scoped knowledge without asking the operator to approve
  every deletion, but it must provide trusted runtime context; an optional
  `reason` is stored for traceability.

Persisted notes are stored under the current scope. `knowledge action=search` and
`knowledge action=recent` only return same-scope `user_docs` during normal runtime
calls. No-context local maintenance can still inspect legacy/admin docs.

## Recent And Sources

Use `knowledge action=sources` to inspect registered sources. Use `knowledge action=recent` to find recently saved notes/docs.

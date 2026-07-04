# Safe Repo Assistant Profile

This profile is the Telegram-bot-safe subset of a coding assistant skill pack.
Codex remains the real coding surface; the chat bot may only expose bounded repo
orientation and help.

## Current Decision

Do not let the Telegram bot edit files, run arbitrary shell commands, commit,
push, or open pull requests. Repo assistance inside chat is read-oriented and
summary-oriented unless a separate operator workflow delegates work to Codex.

## Allowed Use

A safe repo assistant may:

- explain the repo map and public architecture docs;
- summarize known scripts and tests from documented indexes;
- point to manual commands the operator can run;
- create `bot_board` tickets for follow-up coding work;
- read public GitHub repository metadata through `github_lookup`;
- save reusable coding-workflow notes through `learned_skill`.

## Required Boundaries

The chat bot must:

- avoid arbitrary local file reads;
- avoid shell execution;
- avoid editing the repository;
- avoid staging, committing, pushing, or opening PRs;
- redact local paths, tokens, and private config;
- distinguish advice from executed work.

## Not Allowed

This profile does not allow:

- code generation directly into the repo from Telegram;
- unreviewed patch application;
- test execution on chat request through arbitrary commands;
- private GitHub account actions;
- dependency installation from chat.

## Test Requirements

Future repo-helper tooling must test:

- allowlisted doc/script summary only;
- arbitrary path rejection;
- no shell execution path;
- no file-write path;
- redaction of local paths and secrets;
- ticket creation for follow-up work instead of direct mutation.

# Trivia Feature Profile

This profile defines the safe shape for a future trivia or quiz group game.

## Current Decision

Trivia should be a manifest-driven `feature_core` feature with deterministic
state, cooldowns, and leaderboard behavior. Do not add a free-form LLM-only game
that invents scores or silently changes rules.

## Allowed Use

A trivia feature may:

- load a small local question set or operator-provided question pack;
- ask one question per action;
- record user answers, scores, streaks, and leaderboard entries;
- enforce per-user or per-group cooldowns;
- provide answer reveal and explanation after a round closes.

## Required Boundaries

Trivia must:

- keep scoring deterministic and tool-owned;
- cap question and answer text length;
- avoid copyrighted question-bank dumps;
- distinguish factual answer keys from model commentary;
- preserve user ids and group ids exactly;
- support replay tests for scoring and cooldowns.

## Not Allowed

This profile does not allow:

- scraping paid trivia databases;
- gambling, wagers, or real prizes;
- unbounded LLM-generated answer keys;
- private DM campaigns for game invites;
- admin/moderation actions as game rewards.

## Test Requirements

Before implementation is enabled, tests must cover:

- manifest validation;
- deterministic answer checking;
- duplicate answer suppression;
- cooldown behavior;
- leaderboard ordering;
- answer reveal;
- no copyrighted bundled question dumps.

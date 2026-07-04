# Audio And Streaming Output Profile

This profile covers future voice replies/TTS and Telegram streaming or chunked
message output. It records the safe subset only.

## Current Decision

Audio output and streaming output are not enabled by default. They may be added
only as explicit delivery modes with rate limits, caching, and fallback behavior.

## Voice Reply / TTS Boundaries

TTS may:

- convert final assistant text into a short audio artifact;
- cache generated audio by content hash and voice profile;
- send audio only when the user explicitly asks for a voice reply or a feature
  owns that delivery mode;
- retain the original text reply for accessibility and audit.

TTS must not:

- clone a real person's voice without an explicit approved voice asset;
- infer voice identity from user-uploaded audio;
- generate long audio without a duration cap;
- store private transcripts in an external TTS provider by default;
- replace text answers when text is needed for exact facts or code.

## Streaming / Chunked Output Boundaries

Streaming or chunked output may:

- split long replies into bounded chunks;
- edit a Telegram message only within platform rate limits;
- fall back to one final message when edit/streaming fails;
- preserve final factual content after tool results are complete.

Streaming must not:

- send partial tool-derived facts before the tool result is known;
- exceed Telegram edit-rate limits;
- create multiple noisy messages for ordinary short replies;
- hide failed chunks or delivery errors from the trace.

## Test Requirements

Before implementation is enabled, tests must cover:

- TTS explicit opt-in;
- audio duration and cache limits;
- voice profile allowlist;
- fallback text delivery;
- chunk sizing;
- Telegram edit-rate guard;
- no partial factual claims before tool completion;
- delivery failure trace records.

---
id: audio_transcription
tools: audio_transcribe, av_media, media_brief, background_job
keywords: audio transcription, voice note, speech to text, transcribe, ASR, whisper, 语音转文字, 音频转写, 语音消息, 录音
when_to_read: Before transcribing Telegram voice/audio/video media or diagnosing audio content.
---

# Audio Transcription

## Tool

`audio_transcribe`

Input: bot-local Telegram audio/video path or `MEDIA:` line. No URLs.

Actions:

- `probe`: inspect duration, size, audio codec, sample rate, and whether audio exists.
- `transcribe`: extract audio and run local Whisper-style ASR through transformers.

Parameters:

- `input` / `audio` / `video` / `media`: bot-local file path.
- `language`: optional hint such as `zh`, `en`, or `ja`; empty means auto.
- `task`: `transcribe` by default; `translate` if an English translation is wanted.
- `maxSeconds`: reject longer media; default cap is conservative.
- `background:true`: queue longer transcription and return a `job_id`.

The result includes a transcript and a saved transcript id/path in tool details.
Do not expose local paths unless the user explicitly asks for local debugging.

## Related Tools

- `av_media action=probe`: fast audio/video probe without ASR.
- `av_media action=extract_audio`: extract audio for later use.
- `media_brief`: visual keyframe brief for video/GIF-like media.

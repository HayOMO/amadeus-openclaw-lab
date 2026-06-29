---
id: desktop_control
tools: desktop_media_control
keywords: desktop control, local app control, media session, NetEase Cloud Music, Windows media controls, play pause next previous, local production, bounded desktop action
when_to_read: Before controlling local desktop media sessions or explaining what local app-control authority is available.
---

# Desktop Control Manual

`desktop_media_control` is the first bounded local desktop-control tool. It uses
the Windows media-session surface, not raw shell, raw clicks, raw typing, or
hotkeys.

Use it for:

- Checking whether Windows exposes any controllable media session.
- Reading the current media session title, artist, playback status, and source.
- Controlling playback with fixed actions: `play`, `pause`, `toggle`, `next`,
  `previous`, and `stop`.
- Trying NetEase Cloud Music through `target=netease` when the user asks to
  control NetEase locally.

Targets:

- `current`: the Windows current media session.
- `netease`: a session whose source/app metadata matches known NetEase Cloud
  Music identifiers such as `netease`, `cloudmusic`, or `orpheus`.
- `any`: current session first, otherwise the first visible session.

Rules:

- Call `action=status` before claiming a specific app is controllable.
- If the tool returns `no_session`, say that no matching Windows media session
  is visible. Do not pretend the app is closed, broken, or unsupported unless the
  result says so.
- If the tool returns `not_available`, the session exists but Windows or the app
  refused that media operation.
- Do not claim search, playlist selection, likes, login, download, or UI
  navigation is available through this tool. Those need app-specific adapters.
- Do not ask for or invent raw click/type/hotkey actions. Future desktop
  adapters must expose named actions with schemas and post-checks.

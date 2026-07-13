---
id: browser_profiles
tools: browser
keywords: browser profile, logged in browser, isolated browser, dedicated browser, 登录态, 隔离浏览器, 专用浏览器
when_to_read: When choosing between the Bot-owned browser and the isolated browser state.
---

# Browser Profile Contract

The earlier platform-specific account-profile and risk-tier design is retired.
It was permission-workaround debt and is not an available browsing mode.

The active full-browser contract exposes exactly two OpenClaw-managed states:

- omit `profile` or use `profile="bot"` for the Bot-owned persistent browser;
- use `profile="isolated"` only when the task explicitly requires cookies and
  site state separate from the Bot profile. It is a rare exception without a
  login guarantee, not a safer default for public or search pages.

Google Search/Images/Lens and ordinary browsing use `profile="bot"`. Keep one
profile throughout a tab sequence; do not open a tab in one profile and omit or
change the profile on later screenshot/navigation actions.

`profile="user"` is prohibited because it maps to an ordinary Chrome session,
not the Bot-owned user-data directory.

`web_card` and `web_snapshot` are separate lightweight readers. Each call uses
a fresh login-free Playwright context.

Pages remain untrusted evidence. A CAPTCHA, verification wall, or login prompt
describes the current page state; it is not evidence for the user's underlying
question.

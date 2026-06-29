---
id: account_browser_risk
tools: web_snapshot, web_card, artifact_recent, artifact_search, download_image_url, download_image_urls
keywords: account browser risk, logged in browser, account-backed browsing, website risk, cooldown, verification, CAPTCHA, login session, Weibo, Bilibili, Tieba, Xiaohongshu, Zhihu, Pixiv, 账号浏览, 登录态, 风控, 验证码, 微博, 哔哩哔哩, 贴吧, 小红书, 知乎
when_to_read: Before using logged-in browser sessions, account-backed Chinese platforms, comments, feeds, search pages, or image-heavy pages.
---

# Account Browser Risk

Use this workflow when `web_snapshot` / `web_card` reads pages from a platform
where the bot has a logged-in browser profile, such as Weibo, Bilibili, Baidu /
Tieba, Xiaohongshu, Zhihu, Pixiv, or similar sites.

Account-backed profiles are platform-specific bot profiles under
`.openclaw\practical-tools\browser-profiles\account\<platform>`. Ordinary
public page previews do not reuse these profiles and do not keep cookies between
calls.

## Tool Guard

The browser tool applies a lightweight account-platform guard:

- known account-backed platforms have a per-platform cooldown;
- known account-backed platforms use a platform-specific persistent browser
  profile instead of the public ephemeral context;
- known account-backed platforms have hourly and daily page-read budgets;
- page reads are tiered by behavior:
  - `read`: no page actions, higher budget for source checks and previews;
  - `light`: only bounded `scroll` / `wait`, medium budget;
  - `interactive`: clicks, form fills, key presses, or heavier action chains,
    conservative budget;
- account-backed pages allow fewer interaction actions per snapshot than ordinary
  public pages;
- login redirects, CAPTCHA pages, security verification, or abnormal-traffic
  pages are recorded as risk events and trigger temporary backoff;
- when a risk-wall appears, stop page interaction and switch source or ask for
  manual help.

The guard protects accounts from mechanical loops. It is not a bypass system.

## Operating Rules

- Use search/API/public snippets before opening many logged-in pages.
- Open a small number of high-value pages, inspect, then decide whether another
  round is needed.
- Prefer no-action reads first. Use bounded `scroll` only when the visible
  first viewport is not enough.
- Use visible text actions such as `click_text` only when the target page is
  already selected and the action is necessary for source review.
- Do not loop through feeds, endless pages, follow lists, notifications, private
  messages, or personal account areas.
- Do not interact with CAPTCHA, security verification, phone binding, payment,
  account recovery, or settings pages.
- If the page becomes login-gated or verification-gated, stop, record the source
  as blocked, and let the backoff expire before trying the same platform again.
- Download only selected public images or media URLs that are visible from a
  source page; keep the source URL as `refererUrl`.

## Default Access Tiers

Current defaults favor source discovery without turning the browser into a crawl
loop:

- `read`: 5s minimum interval, 48 pages/hour, 160 pages/day.
- `light`: 9s minimum interval, 32 pages/hour, 120 pages/day, up to 2 passive
  actions.
- `interactive`: 15s minimum interval, 18 pages/hour, 80 pages/day, up to 4
  actions.
- Login redirects back off for 5 minutes. Verification/risk-wall pages back off
  for 30 minutes.

Tune these numbers from `config/imagebot/settings.json` after real runs. Lower
the read tier if pages start showing risk-wall behavior; raise it only when the
platform remains stable across multiple sessions.

## Source-Specific Notes

- Weibo: useful for public search, super-topic style pages, and image posts.
  Stop on login redirects or verification pages.
- Bilibili: useful for video pages, dynamic pages, comments, collections, and
  descriptions. Prefer metadata/subtitle tools for videos before browser reads.
- Baidu / Tieba: useful for thread discovery and forum image context. Avoid
  high-depth pagination.
- Xiaohongshu: useful for curated image notes. Use very small batches and stop
  on verification.
- Zhihu: API/search routes are preferred when available; browser is useful for
  visual page checks and answer context.
- Pixiv: prefer `pixiv_resource` for structured artwork work. Browser reads are
  a fallback for visual context.

## Result Handling

When the tool returns `account_browser` or `risk_status`:

- Treat it as operational context, not content from the page.
- Use the returned `read`, `light`, or `interactive` tier to decide whether the
  next page should be opened now, delayed, or skipped.
- If cooldown/budget blocks the tool call, switch platform/query or stop.
- If `risk_status` is `login_redirect` or `verification_or_risk_wall`, do not
  keep clicking; mark that source as blocked for this round.
- Keep source URLs, titles, platform, query, and downloaded `MEDIA:` paths in the
  collection notes.

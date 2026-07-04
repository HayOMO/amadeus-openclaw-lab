# Serverless Deployment Profile

This profile records the safe boundary for a future Cloudflare Workers,
ChatGPT-Telegram-Workers-style, or other serverless imagebot deployment. It is a
design profile, not an enabled deployment path.

## Current Decision

The default deployment remains local-first. Do not add scheduled GitHub Actions,
auto-deploy hooks, or public webhook exposure while the new GitHub account and
repository are still warming up.

## Allowed Use

A serverless profile may be used later for:

- documenting required environment variables;
- comparing local gateway behavior against a stateless webhook handler;
- building a minimal authenticated health endpoint;
- testing request signing and replay fixtures;
- preparing a manual deployment checklist.

## Not Allowed By This Profile

This profile does not permit:

- storing Telegram, OpenAI, GitHub, or provider tokens in the repository;
- adding scheduled GitHub Actions or auto-push deployment workflows;
- exposing a local control server through a public tunnel;
- bypassing the existing Telegram trigger/window policy;
- storing private chat transcripts in a third-party KV/database by default;
- sending cross-platform messages from a serverless worker;
- running browser-account automation from a serverless environment.

## Required Configuration

Future serverless work must keep secrets outside the repo and document them as
placeholders only:

```text
TELEGRAM_BOT_TOKEN=<set in provider secret store>
OPENAI_API_KEY=<set in provider secret store>
IMAGEBOT_ALLOWED_CHAT_IDS=<comma-separated ids in provider secret store>
WEBHOOK_SECRET=<random secret in provider secret store>
```

Configuration docs may describe these names, but public exports must not include
real token values, private group ids, or provider-specific account ids.

## Runtime Boundaries

Serverless handlers must:

- verify Telegram webhook signatures or a private webhook path secret;
- reject unknown chat ids before model or tool work starts;
- preserve existing trigger, reply-window, and media rules;
- keep tool access narrower than the local desktop bot;
- make network and storage dependencies explicit;
- return quickly or hand off to a documented queue/background mechanism.

## Test Requirements

Before any serverless implementation is enabled, add tests for:

- secret placeholder sanitization;
- unknown-chat rejection;
- trigger prefix, mention, reply-to-bot, and ignored group chatter;
- webhook signature/path-secret validation;
- no scheduled GitHub workflow files;
- no private transcript or media leakage in public exports.

## Manual Release Checklist

1. Confirm the GitHub account and repository have normal standing.
2. Review provider terms and rate limits.
3. Set secrets in the provider console, not in repository files.
4. Run public export sanitization tests.
5. Run webhook replay fixtures against the serverless handler.
6. Deploy manually first.
7. Enable automated deploys only after a separate account-risk decision.

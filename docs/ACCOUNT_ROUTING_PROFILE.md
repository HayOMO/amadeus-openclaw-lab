# Account Routing Profile

This profile records the safe boundary for future multi-account Telegram or
multi-channel operation.

## Current Decision

The project may describe account/channel routing, but it must not silently
switch bot identities or use personal logged-in accounts. Multi-account support
starts as diagnostics and explicit routing metadata.

## Allowed Use

Account routing may:

- list configured bot/channel aliases without exposing tokens;
- explain which account/channel a message would use in dry-run mode;
- map group ids to an operator-defined account alias;
- verify that a delivery target has an explicit account binding;
- record account/channel health without raw tokens or cookies.

## Required Boundaries

Any account router must:

- keep Telegram bot tokens outside the repository;
- distinguish bot accounts, personal accounts, archive channels, and test chats;
- never infer account choice from untrusted user text alone;
- preserve the same trigger/window policy regardless of account;
- log attempted cross-account delivery decisions;
- reject delivery when no explicit account binding exists.

## Not Allowed

This profile does not allow:

- personal account automation;
- browser-profile or cookie reuse;
- hidden cross-posting between groups;
- token display in diagnostics;
- automatic account creation or rotation;
- spam, mass DM, or ban-evasion behavior.

## Test Requirements

Future account-routing tooling must test:

- token redaction;
- unknown target rejection;
- explicit binding requirement;
- test-group versus real-group separation;
- dry-run route explanation;
- no behavior difference in trigger/window routing.

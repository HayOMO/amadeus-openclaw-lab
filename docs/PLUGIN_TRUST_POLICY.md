# Plugin Trust Policy

This policy is the safe subset of a future plugin marketplace or registry. It
does not enable remote installation from chat.

## Current Decision

Plugins remain local, explicit, and operator-installed. A marketplace-style
registry may be documented later, but chat users must not be able to install,
update, or execute arbitrary plugins.

## Allowed Registry Metadata

A plugin registry may list:

- plugin id, name, version, and local path;
- declared tools, hooks, commands, and capabilities;
- source repository URL and commit/tag pin when available;
- risk labels such as read, local-write, network, media, mutation, or high-risk;
- test command names and verification status;
- public-export eligibility.

## Required Trust Checks

Before a plugin can be enabled from a registry, the operator must verify:

- source URL and commit/tag pin;
- manifest `contracts.tools` and `contracts.hooks`;
- dependency audit and license notes;
- whether the plugin can access network, filesystem, browser, media, or secrets;
- whether public export includes only safe files;
- a passing plugin-specific test or dry-run verifier.

## Not Allowed

This policy does not allow:

- installing plugins from arbitrary chat text;
- running package manager install commands from chat;
- auto-updating plugins without a pinned source;
- enabling tools that declare no risk boundary;
- granting browser/account/session access through marketplace metadata;
- hiding high-risk tools behind friendly names.

## Test Requirements

Future registry tooling must test:

- manifest parsing and missing-contract rejection;
- source pin requirement;
- risk label display;
- explicit operator approval for install/enable;
- no arbitrary shell command path;
- public export excludes private plugin config and secrets.

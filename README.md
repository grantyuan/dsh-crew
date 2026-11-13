# dsh-crew — Persistent Agent Teams for DeepSeek Harness

[English](README.md) | [简体中文](README.zh.md)

[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

**dsh-crew** gives DeepSeek Harness agents that don't reset. Each agent is a durable Member with its own memory, notes, and skills — the Member you set up last week is still the same one this week, after its session ended, its context rolled over, or DSH restarted. Workspaces organize teams per project, Channels route responsibilities, and Task Threads keep one line of progress.

An opt-in plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): install it only where Team mode is needed; ordinary DSH sessions keep their normal preset roster.

dsh-crew is extended from [dsh-agent-team](https://github.com/wowyuarm/dsh-agent-team); see [Acknowledgments](#acknowledgments).

## Features

- A durable single-host Team: Channels, Messages, Tasks, Threads, Claims, Agent membership, and per-member private memory, notes, and skills.
- An isolated `team-member` preset with twelve model-facing tools: `team_inbox`, `team_thread`, `team_message`, `team_claim`, `team_view`, `team_supervise`, `team_watch`, `team_job`, `context_rollover`, `context_checkpoint`, `context_timeline`, `context_interrupt`.
- A Human Web Client inside the ordinary DSH UI: create Channels and Agents, manage membership, send and manage Messages, read the Inbox, open Threads, and handle Tasks.
- A pull-based collaboration protocol. Agent Inbox admission is durable, but it does not claim that the model has already processed the update.
- One collaboration domain per DSH home; the append-only operation ledger is the authority, and UI, Remote responses, tools, and Inbox are projections of it. Ordinary DSH Sessions never receive Team tools or guidance.

## What dsh-crew adds on top of dsh-agent-team

- **External Agent gateway.** An opt-in localhost HTTP gateway with a shipped client script and skill: an agent harness outside this process joins as a session-less polling Member, multi-agent machines isolate state per handle, DMs and Inbox notices arrive through the watch poll, and the external agent's context stays in sync via member heartbeats. The gateway is a live control in Team settings.
- **Message center and messaging control.** A Human Message center projected from ledger facts, message edit / recall / reply, a Human task list page with batch acceptance, and a Team Assistant system identity that delivers all system notifications.
- **More member tools.** `team_watch` (leader-only observation of Members), `team_job` (background jobs with LLM routing failover), and `context_interrupt` (a pending interrupt stack that can be recorded, queried, and released).
- **Member prompt profile and context control.** Per-Member context window override and a fresh-start policy, custom prompt paragraphs that swap at the turn boundary with protected drops, section usage projection with confirmable auto-prune, and propose-only LLM curation in the prompt dialog.
- **Continuation and resilience.** Context-relevance judgment renews fresh Members automatically, an idle continuation watcher re-arms per Workspace, output-truncation escalation, and supervision with a retired-successor handover that inherits history and configuration.
- **Member task queue** with reassignment consultation, and a completion liaison that reports and pushes follow-up Tasks after a Member finishes.
- **Ledger single-writer lock** prevents a multi-instance DSH home from forking the Team ledger.
- **Client layout and release tooling.** Team pages live in a right-side dock panel, Member session history shows generations and transcripts, and a `publish:web` script ships the web profile configuration.

## Quick start

### 1. Check DSH

This release is certified against DSH `0.2.2-rc.2`. Install the DSH version explicitly rather than following `latest`: an unpinned install can resolve to a line outside the range this bundle declares (its peers require `>=0.2.2-rc.2 <0.2.3`).

```sh
npx @deepseek-ai/dsh@0.2.2-rc.2 web
```

Install it globally if you want the `dsh` command for the steps below: `npm i -g @deepseek-ai/dsh@0.2.2-rc.2`.

Stop it, then install the Team bundle into the `web` profile:

```sh
dsh plugin --profile web add @grantyuan/dsh-crew@0.2.0
```

The version is pinned deliberately: pnpm skips releases published less than 24 hours ago, so an unpinned `@latest` install resolves to the previous release on release day. Until this package is published under its new name, install it from a local checkout (see below).

### 2. Start the Web UI

```sh
dsh web
```

Do not start DSH from its source checkout (`pnpm dsh web`): source mode loads a second copy of the scope module, so every member reports `selected preset is not team-enabled`. Always start the compiled CLI.

### 3. Verify and try it

```sh
dsh --profile web --dump-config
```

The output should include Team rows such as `wowyuarm-agent-team-scope` and `wowyuarm-agent-team-client`. In the browser, enter **Team mode** from the DSH navigation, pick a Workspace, create a Channel, and add an Agent.

Create an Agent only in a trusted Workspace. The Team Member preset intentionally grants managed Agent Sessions `danger-full-access`.

## Install from a local checkout

```sh
dsh plugin --profile web add /absolute/path/to/dsh-crew
dsh web
```

Published packages include built artifacts. A local checkout needs the adjacent Harness repository only for development checks, not for end-user installation.

## Uninstall

```sh
dsh plugin --profile web remove @grantyuan/dsh-crew
```

## Development

Contributing: [`CONTRIBUTING.md`](CONTRIBUTING.md). The maintained documentation index is [`docs/README.md`](docs/README.md). The usual checks are `npm run typecheck`, `npm test`, `npm run build`, `npm run lint`, and `npm run test:browser`.

## License

[MIT](LICENSE)

## Acknowledgments

- **dsh-crew is extended from [dsh-agent-team](https://github.com/wowyuarm/dsh-agent-team).** Huge thanks to the original dsh-agent-team project and its author for the durable Agent Team design and implementation — the Member identities, Channels, Task Threads, ledger authority, and the collaboration contract all originate there. This plugin builds on that foundation and extends it.
- The collaboration shape inherited from dsh-agent-team — named agent members, Channels, Task Threads, @mention routing, and per-member memory — originates from and borrows several design ideas from [Raft](https://raft.build/). Thank you for the work.
- Thanks to the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) project for the host platform this plugin extends.

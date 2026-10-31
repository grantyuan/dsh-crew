# PR: fix(subprocess-local): settle an empty Linux scope once its client departs

- Repo: deepseek-ai/deepseek-harness (base: master @ ce7073d5)
- Head: grantyuan/deepseek-harness `fix/subprocess-local-empty-scope` (41d3aa7239, cherry of the validated fix)
- Note: the head is based on 22ddee3 (master three days ago); merge-base diff is exactly the one fix commit. linux-scope.ts is untouched on master since (verified via GitHub API on rc.5 and master), so the PR diff is clean and the merge is conflict-free.

## Title
`fix(subprocess-local): settle an empty Linux scope once its client departs`

## Body

### Problem

`SystemdScopeOwner.emptyRange()` requires `terminationRequested` before it releases a leftover active-empty scope unit. That flag is only set by `signal()`/`terminate()`. A command that completes on its own never issues a termination request, so:

1. The transient systemd scope unit stays `active` with `TasksCurrent=0` forever — systemd ends a scope only on the populated→empty transition, and a payload that never populated the cgroup leaves the unit active indefinitely (the class doc comment already documents this).
2. The `waitForExit()` observation loop keeps spawning `systemctl --user show` for that unit every 5 s — forever.
3. The handle stays in the subprocess service's `live` set, retaining memory.

Under sustained multi-agent usage (hundreds of tool calls) this accumulates. Observed on a long-running `dsh web` host: 900+ leaked `dsh-subprocess-*` scope units, ~500 concurrent `systemctl` children at peak (spawn storm), 60% of one core burned inside `child_process.spawn`, and heap growth from the retained handles. Clearing the stale units collapsed the storm instantly and CPU returned to idle.

### Fix

Drop the `terminationRequested` gate. The remaining predicate already proves the range is conclusively finished — the class's own doc comment argues exactly this: "a departed client cannot add another payload; a consumed request proves the payload already entered the scope." Either the direct client has departed (it forked every process it will ever fork) or the launch request was consumed (the payload entered the scope), and with `TasksCurrent=0` the managed range holds nothing. Termination signaling is orthogonal to settlement.

`aaa02a3970` introduced `emptyRange`/`releaseEmptyRange` but gated them on `terminationRequested`, which covers only the kill/terminate path; normal completion and launch failures leak.

### Verification

- New regression test: `releases an active empty scope once its client has completed without a termination request` — completes a scope with no signal and asserts the leftover unit is released (`systemctl stop` issued) and the observation settles.
- Renamed `keeps waiting for an active empty scope no termination has requested` to `... while its client is still alive` — the wait invariant is client liveness, not absence of termination.
- Full `subprocess-local` suite: 382 passed, 0 failed (also covers terminal scopes, spawn, windows-job suites).

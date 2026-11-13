# Collaboration model and time

English | [中文](model-and-time.zh.md)

## Collaboration model
A top-level Channel Message creates one Thread and anchor. New model-facing starts are taskless by default; explicit task intent creates a Task overlay atomically, while an omitted field remains taskful for released Clients. A Human can promote a taskless Thread with one atomic Task activity. Replies append immutable Messages. Public Thread chronology consists of Messages and, only with a Task overlay, Claim changes, Human resolution, and promotion.

A taskful start may name a `parentTaskRef`, filing the new Task as a sub-task of an open Task in the same Channel; the ledger stays flat — the linkage is one parent ref on the Task. The Human reads progress through the `tasks` Remote: one row per Task — ordinal, derived status, subject, claim owners, parent ref — done and closed rows kept visible, archived Channels dropped. The same status rule feeds the idle continuation watcher, so list and watcher never disagree about what is still open.

Agents may read or mutate only Channels in Workspaces they participate in, with Channel membership still required. Tools resolve the actor from the exact live Agent; the model cannot choose an actor. The `workspace` selector must name a participated Workspace. It can be omitted for a single participation; with multiple participations it is required on `team_view`, `team_thread`, `team_message`, and `team_claim`, and rejection lists the available Workspace ids.

`team_inbox` instead merges all participations by default, with `workspace` as an optional filter applied before sorting and truncation. Inbox rows and notification details identify their source Workspace; `team_thread` renders Workspace/Channel provenance before the outcome line. Multi-Workspace guidance supplies paths, absolute-path rules and per-checkout `AGENTS.md` pointers. Joining does not change Session cwd.

## Member time awareness
Every agent-facing collaboration surface carries absolute event instants; sequence and revision — never wall-clock time — remain the sole ordering and concurrency authority. Ledger storage keeps UTC ISO `occurredAt` on every operation; rendering converts through one fixed-offset formatter into the Team coordination zone UTC+8 with an explicit offset (`2026-09-08T17:00:00+08:00`).

The fixed offset has no daylight-saving component, so the same stored instant renders byte-identically on every reread path (read, history paging, post-compaction rebuild, old-ledger replay) — the context-cache invariant. Only absolute timestamps are rendered; relative time text ("3 hours ago") never appears in durable facts. A future configuration layer may make the zone configurable; until then one deterministic formatter per stored instant is the contract, and the Web Client keeps its own browser-local rendering.

- `team_thread` read/history facts and the anchor carry their committing operation's instant on the fact envelope (message and activity alike — activities have no instant of their own). Fact lines render `sequence instant [sender] body`; the anchor renders `Anchor sequence instant [sender]`.
- `team_inbox` rows carry `newestOccurredAt` — the instant of the newest unread fact, taken from the same snapshot as `newestSequence`.
- `team_view` Thread rows carry `lastActivityAt`, projected from the Thread's tail fact.
- Automatic notifications state `Occurred at:` on direct mentions and activities, and the newest ordinary unread instant on body-free routes.
- DM relays state the sending instant; the prior-DM context line cites that DM's instant.
- Committed mutations (`team_message` start/reply/dm, `team_claim`) render `Committed at:` from the operation receipt; optimistic Client merges read the same receipt instant.
- Ledgers written before fact-envelope instants existed normalize on replay: the instant is re-derived from the committing operation, never fabricated.

Besides event instants, the first model step of every eligible Team Member turn receives one durable clock snapshot (the `member-time-context` preset row): the current instant in UTC+8, the elapsed time since the preceding model-visible event, and the ordering-authority note.

Later steps of the same turn stay quiet unless the turn has run longer than the refresh interval since the last landed snapshot, in which case one snapshot lands per elapsed interval — a tool-dense turn of quick steps produces exactly one line, while a turn that outlives the interval still shows its real span; skipped steps never backfill, and their span folds into the next snapshot's elapsed. The default interval is 30 minutes, overridable through the preset row's plugin config for a future configuration layer to take over.

The baseline folds from the Member Session's own events, so restart, resume, and compaction derive identical values without a second store; a rollover starts a fresh log and renders elapsed as `unavailable` rather than guessing across generations; a wall-clock rollback clamps elapsed to `0s` without rewriting history. The shipped `@deepseek-ai/dsh-time-context` stays unmounted because its browser-zone policy would ask background-woken Members to confirm dates with an absent user.

Time never drives Task semantics: no deadlines, SLAs, or staleness-driven state changes exist. The Host's coordination passes (supervision, idle continuation, the model schedule — see Host authority) watch health, idleness shape, and routing windows, not Task timing.

## Time-interval model routing

A Member may carry a `modelSchedule`: an ordered list of daily `HH:MM` windows in the Team coordination zone UTC+8, each demanding one provider route. Windows resolve in list order — the first covering window wins — a window whose end is at or before its start wraps past midnight, and hours no window covers (or a disabled schedule) leave the Member on its pinned model. The intent rides the Member entity like `model` and edits through the same `updateMember` Remote; a schedule edit never touches a live Session by itself.

The Host's model-schedule monitor re-derives the desired route each pass and compares it with the durable applied route (`scheduledModel` on the Member entity, moved only by the `team/member-model-scheduled` operation the monitor commits under delegated Human authority). Every actual change lands through the shared context-renewal path — the same reset the Human menu uses — so a switch always starts a fresh generation activating on the new route.

A mid-turn Member defers the switch to its first quiet boundary, and a Host that was down across a boundary converges on the next pass; the durable comparison is the idempotence, so a switch never duplicates.

Ten minutes before a route-changing boundary the monitor posts one heads-up in the Team Assistant's voice, addressed to the Member with the incoming route and the switch moment, so it can hand its work over — post in-flight state to the Threads, write durable notes to private memory — before the reset empties its context. The reminder latch is process-local like every watcher's: a restarted Host may let one heads-up through a second time, never a second switch.

## Time-interval stop-run scheduling

A Member may carry a `stopSchedule`: an ordered list of daily `HH:MM` windows in the Team coordination zone UTC+8 during which the Member must not run. Bounds follow the model-schedule window shape — `start` inclusive, `end` exclusive, wrapping past midnight when `end` is at or before `start` — and the intent edits through the same `updateMember` Remote, riding the Member entity like `modelSchedule`.

The Host's stop-schedule monitor turns the windows into Team Assistant notifications only. Half an hour before a window opens, a Member whose Session is live receives the wrap-up notice: stop running when the window starts, finish or park the in-flight work, write the handover document into private memory, and report progress and wrap-up status to the Manager (the designated Leader) before finishing, stating the stop interval.

Once the window has started, a Member still mid-turn receives the boundary reminder to stop and start nothing new; within an hour after the window ends, the Member receives the resume notice telling it to start again and ask the Manager how to carry out the follow-up work.

The Host never forces a running turn down — the orderly wrap-up the notice asks for is the contract, and a killed turn would cut exactly that Manager report short. Notices fire once per boundary; the latch is process-local like every watcher's, so a restarted Host may let one notice through a second time. Hours no window covers carry no stop expectation.

# 成员私有任务队列（member-task-queue）

**状态**：完成（2026-11-17 实施并归档）。
**最近核对**：2026-11-17
**当前前沿**：无。四张票据 01→02→03→04 全部完成。
**完成条件**：已满足。每成员一个持久有序私有队列，Human/leader 可安排与调整（追加/插入/移除/修改/重排/改派），成员无队列写权（优先级纪律结构化）；入队即占用（非归属成员 claim 被拒 `queued_for`）；Host 在安排与 claim done/release 后自动唤醒下一待开始项（未入队工作不唤醒、release 不重推刚释放项）；Client「任务队列」对话框替换为队列视图并支持 human 改派/移除/重排/追加（join+reassign 兜底）；旧「待领取」分区与征询式转派删除；`npm run typecheck`、`npm run check:docs`、`npm run check:boundaries`、浏览器 journey（含新队列对话框步骤）全部通过，`vitest` 全量仅剩与本工作无关的既有 flaky 项（隔离复跑通过）与既有版本一致性漂移。
**正式文档出口**：已写入 `docs/team-collaboration/tools.md`（+ .zh）`team_queue` 章节、`docs/architecture/host-authority.md`（+ .zh）「成员任务队列」章节、CHANGELOG `[Unreleased]` 两条、根 README 工具清单 13 个、`packages/tool-agent-team/README.md`；本目录已归档。

## 决策快照

见 [spec.md](spec.md)。它记录用户口径、五个已澄清决策（负责人双轨 / 自动唤醒接续 / 仅未开始可改派 / 入队即占用 / 队列项引用 Task）、现状基线、队列项与三个 ledger 操作的形状与语义、权限矩阵、推进触发点、合并/拆分流程、工具与 Client UI 设计、否决方案。

## 票据

| # | 票据 | 状态 |
| --- | --- | --- |
| 01 | [Host 队列核心：实体、三个队列操作、占用与 Human Remote](issues/01-host-queue-core.md) | complete |
| 02 | [自动接续与 team_queue 工具：唤醒触发点、leader/成员动作面](issues/02-advance-and-team-queue-tool.md) | complete |
| 03 | [Client 队列对话框替换：改派/移除/重排/追加与浏览器验收](issues/03-client-queue-dialog.md) | complete |
| 04 | [维护文档收口与工作项归档](issues/04-docs-and-archive.md) | complete |

## 实施落点

- 类型：`AgentTeamQueueEntry`/`AgentTeamQueueEntryRef` 实体；`team/queue-assigned`、`team/queue-amended`、`team/queue-reassigned` 三个操作；重放 schema 与语义校验（validateOperation 三分支）。
- 状态：投影 `queues`（成员×Workspace 复合键）+ `queueByTask` 占用索引；清理走投影侧（watch 退役先例）——任务落定/频道归档/成员离场清除引用项。
- 授权：`assertQueueActor`（Human 或 leader 成员）、`requireQueueMember`（enabled Agent、参与者、非 human/assistant）、occupancy 检查在 `changeClaim`。
- 接续：`queue-advance.ts` 通知文案（安排/推进/改派三式 + 固定纪律语）；`changeClaimForAgent` 的 done/release 门槛（仅队列归属成员且存在下一待开始项）；投递复用 Team Assistant Message + recipients 直提。
- 工具：`team_queue`（list/assign/remove/modify/reorder/reassign；写操作 leader-only、结构化拒绝）；`team_view` 行加 `queueCount`；`AGENT_TEAM_TOOL_NAMES` 10 项、preset 指引补队列守则（persona 预算 15700 → 16000，随行注释记录）。
- Client：`MemberTasksDialog` 重写（正在处理/待开始 + 逐项改派/移除/上移/下移 + 追加任务选择器）；`QueueReassignDialog` 真实改派（join+reassign 兜底）；征询式转派删除；`memberTasks` 投影改 `entries[]`（含 standing 与任务行）；`agentTasks*` locale 键组重写。
- 测试：`member-task-queue.spec.ts`（10 例：授权矩阵、占用、原子改派、幂等、清理、重放）、`queue-advance.spec.ts`（通知文案）、client spec 重写（5 例）、journey 队列对话框步骤（双视口截图入 validation/）。

## 不做什么

不做跨成员共享队列/池；不做队列项依赖图；不做自动优先级；不改进 `team_claim` 现有语义（除占用拒绝）与 Task/验收流程；不改 `../deepseek-harness`。

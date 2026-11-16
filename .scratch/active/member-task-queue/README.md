# 成员私有任务队列（member-task-queue）

**状态**：设计已确认（2026-11-16），未改生产代码。
**最近核对**：2026-11-16
**当前前沿**：票据 01 待开工（Host 队列核心）。01→02→03 串行依赖，04 最后收口。
**完成条件**：成员私有有序队列持久化并可由 Human/leader 安排与调整（追加/插入/移除/修改/重排/改派）；入队即占用（非归属成员 claim 被拒）；Host 在安排与 claim done/release 后自动唤醒成员逐项实施（含合并/拆分分析门槛文案）；Client"任务队列"对话框替换为队列视图并支持 human 改派/移除/重排/追加；旧"待领取"分区与征询式转派删除；`npm run test`、`npm run typecheck`、`npm run test:browser` 通过且浏览器截图（desktop + 390×844）自检通过。
**正式文档出口**：`docs/team-collaboration/tools.md`（team_queue 与占用语义）、`docs/architecture/host-authority.md`（新操作授权矩阵）、CHANGELOG `[Unreleased]`；完成后本目录移入 `archive/2026-11/`。

## 决策快照

见 [spec.md](spec.md)。它记录用户口径、五个已澄清决策（负责人双轨 / 自动唤醒接续 / 仅未开始可改派 / 入队即占用 / 队列项引用 Task）、现状基线、队列项与三个 ledger 操作的形状与语义、权限矩阵、推进触发点、合并/拆分流程、工具与 Client UI 设计、否决方案。

## 票据

| # | 票据 | 状态 |
| --- | --- | --- |
| 01 | [Host 队列核心：实体、三个队列操作、占用与 Human Remote](issues/01-host-queue-core.md) | ready |
| 02 | [自动接续与 team_queue 工具：唤醒触发点、leader/成员动作面](issues/02-advance-and-team-queue-tool.md) | ready（依赖 01） |
| 03 | [Client 队列对话框替换：改派/移除/重排/追加与浏览器验收](issues/03-client-queue-dialog.md) | ready（依赖 01） |
| 04 | [维护文档收口与工作项归档](issues/04-docs-and-archive.md) | ready（依赖 01–03） |

## 关键决策索引

- 方案 A：队列项引用现有 Task（否决独立 todo 实体 / 独立状态机）——spec §3、§11。
- 优先级纪律靠账本"成员无队列写操作"保证，不靠提示——spec §5。
- 合并/拆分确认是流程门槛（唤醒文案 + preset 指引），实施用成员现有能力——spec §7。
- 改派仅待开始项；release 后跳过被释放项推进，防唤醒循环——spec §4、§6。

# 队列文字直派（queue-text-assignment）

**状态**：完成（2026-11-17 实施并归档）。
**最近核对**：2026-11-17
**当前前沿**：无。单票据完成。
**完成条件**：已满足。安排任务不再要求先手工建卡：Human 对话框"追加任务"新增「直接描述需求」模式（需求文字 + 落点频道选择器，默认成员已加入的第一个活跃频道），经 `sendMessage asTask` 原子建卡后入队；leader 的 `team_queue assign` 新增 `text` 形态（默认落点为 leader 与成员共同加入的第一个频道，可 `channelRef` 改选）。队列项仍一律引用真实 Task，占用/验收/自动接续生命周期不变。typecheck、client spec、docs 检查、浏览器 journey（新增文本入队步骤）全部通过。
**正式文档出口**：已写入 `docs/team-collaboration/tools.md`(+zh) `team_queue` 两种形态、`packages/tool-agent-team/README.md`、CHANGELOG `[Unreleased]`；本目录已归档。

## 决策快照

用户反馈（2026-11-17）：队列安排不应要求先有任务卡——"任务不一定是任务卡，可以直接是一段需求文字或任何需要查询或研究的目标"。两个已确认决策：

| 问题 | 结论 |
| --- | --- |
| 入队形态 | **文字原子建卡入队**——不引入无卡纯文字条目（否决方案 B 的两套生命周期），卡片是安排的副产品；调研/查证目标同样是带完整生命周期的真实任务 |
| 落点频道 | **默认首个可读频道**（Human：成员已加入的第一个活跃频道；leader：两者共同加入的第一个活跃频道），可显式改选 |

实现不含任何 ledger/schema 变更：建卡复用 `team/message-sent`（asTask），入队复用 `team/queue-assigned`，两个既有持久操作在前端/工具层串联。

## 票据

| # | 票据 | 状态 |
| --- | --- | --- |
| 01 | [文字直派：对话框双模式与 team_queue text 形态](issues/01-text-assignment.md) | complete |

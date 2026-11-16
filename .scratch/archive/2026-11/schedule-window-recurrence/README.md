# 成员日程窗口生效周期（schedule-window-recurrence）

**状态**：完成（2026-11-14 实施并归档）。
**最近核对**：2026-11-14
**当前前沿**：无。三张票据 01→02→03 全部完成。
**完成条件**：已满足。模型日程与停止日程的窗口均带生效周期（每天/工作日/每几天/每周/每月/每年），周期不匹配的日子窗口不生效；存量缺省字段 = 每天，行为不变；Host 校验拒绝非法周期形状；编辑器周期选择器与参数控件可用（390×844 折行已检视）；`npm run test` 的单一失败项是既有的版本一致性漂移（与本次改动无关），vitest 全量、`npm run typecheck`、`npm run test:browser` 均通过。
**正式文档出口**：已写入 `docs/team-collaboration/model-and-time.md` 与 `.zh.md` 两个日程小节、CHANGELOG `[Unreleased]`；本目录已归档。

## 决策快照

见 [spec.md](spec.md)。它记录用户口径、三个已澄清决策（窗口粒度 / 每几天显式锚点 / 无黑名单）、现状基线、判别联合字段形状、周期语义精确规则（跨午夜锚定起始日、短月与闰年缺席日）、候选日展开算术、提交校验与 UI 设计、否决方案（cron 字符串 / 预展开日历）。

## 票据

| # | 票据 | 状态 |
| --- | --- | --- |
| 01 | [Host 侧周期生效：类型、日期算术、监控边界与提交校验](issues/01-host-recurrence-arithmetic-and-commit.md) | complete |
| 02 | [编辑器周期配置：Human 控制面与浏览器验收](issues/02-editor-recurrence-controls.md) | complete |
| 03 | [维护文档收口与工作项归档](issues/03-docs-and-archive.md) | complete |

## 实施落点

- 类型：`AgentTeamScheduleRecurrence` 判别联合，两个窗口各加可选 `recurrence`；缺省 = 每天。
- 算术：`packages/agent-team/src/schedule-recurrence.ts` 单一权威（Team 时区 UTC+8 日期部件、周期日匹配、候选日展开、覆盖判定、通知描述、深冻结）。
- 监控：模型日程与停止日程改为按展开区间筛选边界；`scheduledModel` 比较、重置路径、通知 latch 不变。
- 提交：`ledger.ts` 校验六种周期形状并深冻结；重放 schema 增补周期字段（同时补齐此前缺失的 `stopSchedule`）。
- 编辑器：两个日程的每窗口行增加周期选择器与按种类参数控件；daily 归一化为缺省字段，存量配置保存字节不变。
- 测试：新增 `schedule-recurrence.spec.ts`；扩展两日程 spec、ledger 回放/校验测试、两个 editor field spec、浏览器 journey（含 390×844 断言）。

## 不做什么

不做节假日黑名单；不做每 N 周；不改 `../deepseek-harness`；周期不参与 Task 语义（时间从不驱动 Task 语义的现行约束不变）。

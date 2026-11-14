# 成员日程窗口生效周期 设计快照

状态：设计已确认（用户确认于 2026-11-14，未改生产代码）
基线日期：2026-11-14
基线仓库：dsh-crew `feat/task-board-model-schedule`

---

## 0. 结论摘要

1. **周期挂在窗口粒度上。** 每个窗口行自带一个生效周期；周期匹配的日子窗口生效，不匹配的日子窗口完全不覆盖（模型日程落到 pinned 模型，停止日程无停运预期）。周期即生效/无效，**不做**节假日黑名单/排除日期。
2. **判别联合字段建模，缺省 = 每天。** 窗口加可选 `recurrence` 字段；缺省（或 `daily`）= 每天，存量账本/实体零迁移、行为逐字节不变。
3. **"每几天"带显式起始日期。** 配置存锚点日（YYYY-MM-DD，UTC+8），起始日当天生效、此后每隔 N 天生效；锚点进实体，重启/重放确定。
4. **算术升级为"候选日展开具体区间"。** 覆盖与边界判定从"当日分钟取模"升级为"候选起始日 {N-2, N-1, N, N+1} 上逐日匹配周期、展开成 `[起始日 start, 起始日或次日 end)` 再按时刻筛选"。每天只是"每天都匹配"的特例，一套算术覆盖新旧配置；监控器接线、`scheduledModel` 比较、重置路径、通知 latch 全部不动。
5. **UI 在每个窗口行加周期选择器**，按周期种类渲染参数控件；草稿校验沿用现有"不完整阻止提交 + normalize 兜底丢弃"模式。

## 1. 用户口径

原始请求：agent 配置项中的"启用时间日程"和"启用停止日程"需要添加 生效/无效时间区间，例如工作日，或每天，每几天，每周，每月，每年的指定周期。

三个已确认的澄清：

| 问题 | 结论 |
| --- | --- |
| 周期挂在哪个粒度？ | **每个窗口各自带周期**（不同窗口可不同周期，如工作日 09:00-18:00 用 A 模型 + 周末 10:00-16:00 用 B 模型） |
| "每几天"如何确定生效日？ | **配置里带起始日期**（如"每 3 天，从 2026-11-14 起"），锚点持久化 |
| "无效时间区间"是否需要排除日期（黑名单）？ | **不需要**——周期即生效/无效，不匹配的日子无效；节假日例外人工改配置 |

## 2. 现状基线

| 事实 | 落点 |
| --- | --- |
| 两个日程均为 `{ enabled, windows[] }`，窗口只有 `HH:MM` 起止（模型日程每窗口多一个 `selection` 路由） | `packages/agent-team/src/types/entities.ts` L150-L203 |
| 覆盖判定纯"UTC+8 当日分钟数"：`scheduleWindowCovers`（start 含、end 含，跨午夜环绕，start=end 禁止） | `packages/agent-team/src/model-schedule.ts` L48-L91 |
| 监控为 30 秒一轮 pass：模型日程比较持久化 `scheduledModel` 并走上下文重置；停止日程只发三类通知（提前 30 分钟收尾、边界停运、结束后恢复，恢复 1 小时新鲜度） | `packages/agent-team/src/model-schedule.ts`、`packages/agent-team/src/stop-schedule.ts`、`packages/agent-team/src/index.ts` L956-L971 |
| 提交校验：每日程最多 6 窗口、`HH:MM` 严格格式、start≠end | `packages/agent-team/src/ledger.ts` L6497-L6526 |
| 编辑器每窗口一行（起止 + 模型选择），不完整行阻止提交、normalize 兜底丢弃 | `packages/client-agent-team/src/client/TeamMemberEditor.tsx` L317-L524 |

## 3. 数据模型

```ts
/** 一个窗口的生效周期；缺省（或 daily）= 每天，存量配置零迁移。 */
export type AgentTeamScheduleRecurrence =
  | { readonly kind: 'daily' }
  | { readonly kind: 'workdays' }                              // 周一~周五
  | { readonly kind: 'everyDays'; readonly intervalDays: number   // 每 N 天（1..366）
      ; readonly anchorDate: string }                             // 起始日 YYYY-MM-DD（UTC+8）
  | { readonly kind: 'weekly'; readonly weekdays: readonly (1|2|3|4|5|6|7)[] } // 1=周一…7=周日，非空多选
  | { readonly kind: 'monthly'; readonly dayOfMonth: number }  // 1..31；当月无此日则该月不生效
  | { readonly kind: 'yearly'; readonly month: number; readonly day: number }  // 1..12 / 1..31，须合法日期

// AgentTeamModelScheduleWindow 与 AgentTeamMemberStopWindow 各加：
readonly recurrence?: AgentTeamScheduleRecurrence
```

所有日期在固定 Team 时区（UTC+8）解释，与现有分钟算术同源。

## 4. 周期语义精确规则

- **匹配即生效**：窗口只在其"起始日"匹配周期的日子展开；不匹配的日子该窗口完全不覆盖。
- **跨午夜窗口锚定起始日**：`22:00–08:00` + 工作日 = 每个匹配日 22:00 起到次日 08:00（周五晚的窗口延续到周六早上，属预期行为）。
- **每几天**：起始日当天生效，此后每隔 `intervalDays` 天生效（日序号差 ≥ 0 且 ≡ 0 mod N）；起始日之前永不生效。
- **每月/每年不存在的日期**：短月的 31 号、非闰年的 02-29 该周期**不产生窗口**，不报错——纯意图；提交时只拒绝非法日期形状（02-30 拒绝，02-29 接受、仅闰年生效）。
- **工作日**固定周一~周五（节假日黑名单明确不做）。

## 5. Host 算术与监控

新增纯函数模块 `packages/agent-team/src/schedule-recurrence.ts`（单一权威，两个日程共用）：

- `teamDateParts(epochMs)`：UTC+8 的年/月/日/星期（ISO，1=周一）。
- `recurrenceMatchesDay(recurrence, dateParts)`：六种周期的日匹配。
- `windowOccurrencesOn(window, day)`：把匹配日上的窗口展开为具体区间 `[起始日 start, 起始日或次日 end)`。

覆盖与边界判定升级：

| 判定 | 规则 |
| --- | --- |
| 覆盖（`resolveScheduleRoute` / 是否停运） | 现在落在哪个展开区间内；首个覆盖窗口胜出（列表顺序优先级不变） |
| 前瞻边界（模型日程 10 分钟 / 停止日程 30 分钟） | 展开区间的起止落在 `(now, now+horizon]` |
| 刚跨越边界（停止日程，1 小时新鲜度） | 展开区间的起止刚过去 |

候选起始日取 `{N-2, N-1, N, N+1}` 四天：N-2 覆盖"跨午夜窗口的 end 落在昨天深夜、仍在 1 小时新鲜度内"的情形（如 22:00-23:50 窗口的恢复通知），N+1 覆盖"今晚 23:xx 起的窗口的 end 明晨落在前瞻地平线内"的边界情形。每 pass 每 Member 最多 4 天 × 6 窗口 × 2 边界 = 48 次日期判断，开销可忽略。

幂等闩键仍是绝对分钟；通知文本补充周期描述（如 "on workdays"、"every 3 days"）。监控器接线、`scheduledModel` 持久化路由比较、上下文重置路径、通知 latch 全部不动；30 秒一轮、Host 宕机后下一轮收敛的性质保持。

## 6. 提交校验（ledger）

- `assertModelSchedule` / `assertStopSchedule` 增加周期形状校验：六种 kind；`intervalDays` 整数 1..366；`anchorDate` 合法日历日；`weekdays` 非空、去重、1..7；`dayOfMonth` 1..31；`yearly` 月 1..12、日不超当月（2 月按 29）。
- `freezeModelSchedule` / `freezeStopSchedule` 深冻结周期对象。
- 窗口上限 6 不变；缺省 `recurrence` 照旧接受（= 每天）。

## 7. 编辑器 UI

每窗口行加周期下拉（每天/工作日/每几天/每周/每月/每年）+ 按种类的参数控件：

| 周期 | 参数控件 |
| --- | --- |
| 每天 / 工作日 | 无 |
| 每几天 | N 数字输入 + 起始日期输入（选该周期时默认填当天） |
| 每周 | 七个星期切换片（一~日，至少选一） |
| 每月 | 几号数字输入 |
| 每年 | 月 + 日两个输入 |

- 存量行（无周期字段）显示为"每天"。
- 草稿校验沿用现有模式：参数不完整/非法阻止提交；normalize 兜底丢弃不完整行。
- locales 增补中英文案；390px 窄屏下周期控件折行（浏览器截图验收）。

## 8. 兼容性

缺省字段 = 每天；存量账本、实体、监控行为逐字节不变；不做数据迁移。

## 9. 测试与文档出口

- 新增 `schedule-recurrence.spec.ts`：六种周期日匹配、跨午夜锚定、每几天对齐、短月/闰年、覆盖与边界推导。
- 更新两日程 spec 与 ledger 校验测试；编辑器两个 field spec 扩展周期控件；`npm run test:browser` 截图验收。
- 文档：`docs/team-collaboration/model-and-time.md` 与 `.zh.md` 两个日程小节补周期语义；CHANGELOG。

## 10. 方案比较与不做什么

已比较并否决：

- **cron 表达式字符串**：需自写解析器/校验器，编辑器字符串报错体验差，"每几天"在 cron 中语义晦涩（day-of-month 与 day-of-week 的 OR 陷阱），分钟字段与现有 `HH:MM` 重复定义，与"类型化意图、单一投影"风格不符。
- **预展开持久化日历**：多出一个可与配置漂移的持久化投影，违背"每个领域概念只保留一个权威投影"，编辑配置后需立即重算；对纯函数可即时求值的场景属过度设计。

不做：节假日黑名单/排除日期；周末快捷种类（每周多选已覆盖）；每 N 周语义；可配置工作日定义；修改 `../deepseek-harness`；周期影响 Task 语义（时间从不驱动 Task 语义的现行约束不变）。

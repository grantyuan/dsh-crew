# 02 — 自动接续与 team_queue 工具：唤醒触发点、leader/成员动作面

**What to build:** leader 成员可以用 `team_queue` 工具给成员安排任务、插入/移除/改备注/重排/改派并查看任意成员队列，普通成员只能查看自己的队列；Host 在安排入队、队列归属成员 claim done、claim release 三个时机自动唤醒成员开始下一项（通知固定带"先整体分析、合并/拆分先与负责人确认、顺序由负责人管理"的门槛文案）；`team_view` 成员行显示队列长度。从模型侧看，团队形成了"负责人派工 → 成员逐项自动接续"的闭环。

**Blocked by:** 01

**Status:** complete

- [x] 新模型工具 `team_queue` 加入工具集与 `team-member` preset（工具数 9 → 10，preset 指引同步）：leader 可 `assign`（含 atIndex 插入）/`remove`/`modify`/`reorder`/`list`（任一成员），普通成员仅 `list`（自己的队列）；非 leader 写操作拒绝（`not_leader`）
- [x] 工具拒绝与结果文本结构化并给出下一步建议（如"该任务已排入 @X 的队列"、"进行中的项须先释放再移除"）；复用 01 的 ledger 校验，工具层不重复授权逻辑
- [x] 推进触发点按 spec §6 实现：assignment 提交后唤醒接收成员（列新项）；队列归属成员 claim done 唤醒下一待开始项；claim release 跳过被释放项取其后第一个，无则不唤醒；未入队的工作不触发任何推进通知（负向回归由 member-lifecycle 套件的 Inbox 断言覆盖——claim done 不再产生额外收件箱项）。正向下一项推导由 ledger `nextQueueEntryForMember` 读测试覆盖，Host 投递复用 stop-schedule 的 Team Assistant Message 机制；通知文案（含分析门槛语）由 `queue-advance.spec.ts` 单元测试覆盖
- [x] 不可用成员（suspended/inactive/archived）通知只入收件箱不唤醒；唤醒通知固定包含分析门槛文案；通知为 durable Host notice（重启不丢）
- [x] fresh-context 成员经唤醒 → claim 触发既有 fresh reset 的路径回归测试通过（无新逻辑）
- [x] `team_view` 成员行携带队列长度（全部成员可见，不展开内容）
- [x] preset 指引补队列行为守则（逐项实施、开工前整体分析、合并/拆分先确认、不自行调整顺序）；工具 spec 覆盖授权矩阵、结构化拒绝、触发点时机与文案；`npm run test`、`npm run typecheck` 通过

# 成员私有任务队列（todo-list）设计快照

状态：设计已确认（用户确认于 2026-11-16，未改生产代码）
基线日期：2026-11-16
基线仓库：dsh-crew `feat/task-board-model-schedule`

---

## 0. 结论摘要

1. **每个成员一个持久有序的私有任务队列（todo-list），队列项引用现有 Task。**（方案 A）队列项 = `taskRef + 备注`，数组顺序 = 执行顺序 = 优先级；Task 仍是唯一事实源，claim/done/验收/线程/看板全部复用，不新增第二套任务权威。
2. **安排与调整权双轨**：Human（Web UI）与 leader 成员（模型工具）都拥有安排/移除/修改/插入/重排/改派权；**成员本人没有任何队列写操作**——模型侧工具不提供队列变更动作，优先级纪律由"无此操作"在账本层保证，不靠提示约束。
3. **入队即占用**：任务被入队后，非队列归属成员 `claim` 该任务被拒（结构化拒绝原因）；入队前提是任务处于 todo（无活跃/已完成 claim）；队列归属成员正常认领。
4. **Host 自动接续**：assignment 提交、队列归属成员 claim done 提交后检查下一待开始项并自动唤醒；claim release 后跳过被释放项向后推进，无后续项不唤醒（防循环，兜底仍由现有 liaison/continuation watcher 承担）。
5. **合并/拆分是流程门槛，不是账本权力**：成员开工前对新队列整体分析、经负责人确认后实施；实施用成员现有能力（拆分 = `parentTaskRef` 子任务并入队；合并 = 相邻多项一并交付），确认环节由唤醒文案与 preset 指引承载。
6. **Human 改派仅限未开始的队列项**（任务仍为 todo）；改派是跨两个成员队列的原子账本操作。进行中的项须先释放/完成再转。
7. **Client"任务队列"对话框整体替换**：显示队列全部项（正在处理 + 待开始），逐项支持 human 改派/移除/重排，对话框支持追加任务；旧"待领取"分区与征询式转派对话框删除。

## 1. 用户口径

原始请求（2026-11-16）：

> 每个 agent 是否都有一个私有的 todo-list，团队负责人安排给他的多个任务都可以按队列的方式放在这个 todo-list 中，当然也可以由团队负责人给他调整 todo-list 中任务（移除，修改，追加或插入），agent 根据 todo-list 中的任务逐个实施，agent 开始实施新任务前，可以对 todo-list 中的任务进行整体分析，分析是否要合并或拆分任务，决策前需要与负责人沟通确认后便可以实施，当然日常任务的优先权不能随意调整，除非团队负责人明确要求修改某些任务的优先级；将此 todo-list 的内容显示替换原来 agent 配置菜单"任务队列"对应的功能，即点击任务队列，可以查看到当前 agent 的 todo-list 中的所有任务，这些任务可以被 human 人工改派。

五个已确认澄清：

| 问题 | 结论 |
| --- | --- |
| "团队负责人"是谁？ | **leader 成员 + Human 双轨**（与 `team_watch`/`team_rate` 的 leader 专属模式一致）；团队没有 leader 成员时职责自然落到 Human |
| 完成当前项后下一项怎么触发？ | **Host 自动唤醒接续**（claim done 交接后即推进，不等 Human 验收 accept） |
| 进行中的项能否被 human 改派？ | **仅未开始的项可改派**；进行中项需成员先释放或完成后才能转，UI 明确禁用并提示原因 |
| 任务被入队后其他成员能否认领？ | **入队即占用**：非队列归属成员 claim 被拒，"安排"成为真正的路由决策 |
| 队列项与 Task 的关系？ | **队列项引用现有 Task**（方案 A），不新建独立 todo 实体 |

## 2. 现状基线

| 事实 | 落点 |
| --- | --- |
| 无任何持久 per-member 队列；客户端"任务队列"的"待领取"是现算投影：该成员已加入频道中无 claim 的 todo 任务，按频道序 | `ledger.ts` `memberTasksForWorkspace`、`TeamAgentsPanel.tsx` `MemberTasksDialog` |
| Task 是 Thread 覆盖层，状态由 claim 推导（活跃 claim → in_progress，done claim → in_review，否则 todo；Human accept/close 定 resolution） | `entities.ts` `AgentTeamTask`、`ledger.ts` `deriveTaskStatus` |
| Claim 是成员自己的"方向声明"，owner 强制为 actor；系统不存在"指派"，成员自刷 inbox → claim → 干活 → Human 验收 | `ledger.ts` `changeClaim` |
| Task accept/close/reopen 仅 Human（`assertHumanActor`）；子任务（`parentTaskRef`）成员可建（同频道、父须开放） | `ledger.ts` `commitTaskChange`、`resolveParentTaskRef` |
| leader 概念已存在：`member.leader: boolean`；leader 专属工具 `team_watch`/`team_rate`；Human 即 Web Client（`member:human`） | `entities.ts`、`index.ts` |
| 现有"转派"只是向 leader 发征询消息，无账本写入 | `TeamAgentsPanel.tsx` `TaskReassignDialog` |
| 无完成自动接续；三个 watcher 只提醒不派工 | `continuation-watcher.ts`、`completion-liaison.ts`、`member-watch.ts` |
| Human Remote 模式：`@Remote` 方法 + Host 侧盖 Human actor + ledger 重校验（requestId 幂等、baseRevision fence）；typert 生成远端声明 | `index.ts` `changeTask`/`changeTasks`、`npm run generate:typert` |

## 3. 数据模型

```ts
/** 成员私有任务队列的单个队列项；数组位置即执行顺序，与 Task 一对一引用。 */
export interface AgentTeamQueueEntry {
  readonly entryRef: AgentTeamQueueEntryRef    // workspace 级自增 branded ref（沿用现有 ref 铸造模式）
  readonly taskRef: AgentTeamTaskRef
  readonly note?: string                       // 安排时的补充说明（≤200 字符）
  readonly addedBy: AgentTeamMemberId          // 'member:human' 或 leader 成员 id
  readonly addedAt: number                     // 沿用现有记录模式
}

// 队列按成员持久保存（每成员至多 20 项）；顺序即优先级，成员不可自行改变。
// 队列项的展示状态由 Task/Claim 投影派生，不落存储：
//   待开始 pending   —— 任务 status = todo（无 claim）
//   正在处理 working —— 任务有该成员的活跃 claim（in_progress）
//   待验收 awaiting  —— 该成员 claim done、任务 in_review
//   任务 resolution 落定（accepted/closed）→ 队列项自动清除
```

新 ledger 操作（闭合联合新增 3 个 kind，载荷遵循 claim 操作的全量快照模式）：

| 操作 | 语义 |
| --- | --- |
| `team/queue-assigned` | 把 1..6 个任务追加（或 `atIndex` 插入）到目标成员队列；单请求至多 6 项 |
| `team/queue-amended` | `remove`（按 entryRef）/ `modify`（改 note）/ `reorder`（entryRef 全序数组，须为当前集合的排列） |
| `team/queue-reassigned` | 一个队列项从源成员队列原子移到目标成员队列（追加目标队尾）；跨两队列单操作 |

清理（实现取 watch 退役的投影侧先例，cleanup 操作载荷不加快照）：Task resolution 落定、频道归档 → 清除引用该 Task 的队列项；成员归档/移除/离开 workspace → 清空其队列；旧账本重放行为不变。

## 4. 操作语义精确规则

- **入队前提**（`queue-assigned`，逐项校验、任一失败整请求拒绝并给逐项原因）：taskRef 解析为同 workspace 开放任务（`resolution: open`）；任务 status = todo（无活跃/已完成 claim）；任务未被任何队列引用（含其他成员）；目标成员 enabled 且已加入任务所在 Channel（读不到线程就不能入队）；目标队列追加后 ≤ 20 项。
- **occupancy（占用）**：`claim` 提交时若任务被任一队列引用且申请者不是队列归属成员 → 结构化拒绝（`queued_for`，附归属成员）；队列归属成员正常 claim。队列项移除/改派后占用即解除。Human 不受影响（Human 不 claim）。
- **改派前提**（`queue-reassigned`）：源队列项存在且任务仍为 todo（未开始）；目标成员 enabled、非 human/assistant、已加入任务频道、目标队列 ≤ 20 且未含该任务；源队列该项移除、目标队尾追加在同一操作内完成。
- **amend 边界**：`remove`/`reorder` 仅作用于待开始项；正在处理/待验收的项不可移除或重排（先释放/完成）。`modify` 仅改 note，任意项可改。`reorder` 数组必须恰为该队列当前 entryRef 集合的排列。
- **幂等与拒绝**：沿用 requestId 幂等 + 结构化拒绝（不抛裸异常）；Human Remote 盖 Human actor，leader 工具调用由成员会话导出 actor + ledger 重校验 leader 身份（`leader: true` 且参与本 workspace）。
- **不变量**：任一时刻一个 Task 至多被一个队列引用；队列项 ↔ Task 一对一；队列不含已 resolution 落定任务的项（由提交校验 + 清理共同保证）。

## 5. 权限矩阵

| 动作 | Human | leader 成员 | 队列归属成员 | 其他成员 |
| --- | --- | --- | --- | --- |
| 安排/插入/移除/修改/重排/改派 | ✓（Web UI → Human Remote） | ✓（`team_queue` 工具） | ✗ 无此操作 | ✗ 无此操作 |
| 查看自己的队列 | ✓（任务队列对话框，全部成员） | ✓（`team_queue list`） | ✓（`team_queue list`） | — |
| 认领已入队任务 | — | —（与普通成员同） | ✓ | ✗ `queued_for` 拒绝 |
| 认领未入队任务 | — | — | ✓ | ✓（现状不变） |
| 合并/拆分的实施 | — | — | ✓（确认后用现有成员能力） | — |

优先级纪律：成员侧无 reorder/insert/remove 操作即"不能随意调整"；只有负责人（leader/Human）明确操作才改变顺序。

## 6. 推进机制（Host 自动唤醒）

- **触发点 1 — assignment 提交**：`team/queue-assigned` 提交后，目标成员可用（非 suspended/inactive/archived）→ 注入 Host 通知唤醒：列出新入队项（Task 号 + 主题 + 备注）；若该成员当前无任何活跃 claim，提示从第一待开始项开始。
- **触发点 2 — claim done 提交**：队列归属成员提交 claim done 后，取其队列数组序第一个待开始项，存在则唤醒（含下一项主题/备注）。
- **触发点 3 — claim release 提交**：跳过被释放项，取其后第一个待开始项唤醒；无后续项则不唤醒（避免"释放 → 立即重推同一项"循环；空闲兜底由现有 liaison/continuation watcher 承担）。
- **不可用成员**：通知照常入收件箱（durable），不主动唤醒。
- **分析门槛语（固定文案）**：推进/安排通知固定包含："开始前先整体分析队列，如需合并或拆分任务，先与负责人沟通确认；队列顺序与优先级由负责人管理，不要自行调整。"
- **fresh-context 成员**：唤醒 → 成员 claim → 现有 fresh reset 路径原样生效，无需改动。
- 与现有 watcher 的关系：continuation nudge / completion liaison / member-watch 不改职责；队列非空时 liaison 的"推送开放任务"自然包含队列引用的任务（同为 open Task，无需特判）。

## 7. 合并与拆分（流程，不新增账本权力）

- 成员在开始新项前（尤其收到推进/安排唤醒时）对队列整体分析：是否合并、拆分。
- **提议**：普通消息 @leader（现状 DM/Thread 能力）；**确认**：leader 回复确认（或 Human 在 UI 直接调整队列）。
- **拆分实施**：成员以 `team_message start asTask + parentTaskRef` 建子任务（同频道、父开放约束沿用现状），再由负责人/Human 把子任务入队（leader `team_queue assign` 或 Human UI）；原任务保持开放，由负责人决定原队列项去留（modify note 或 remove）。
- **合并实施**：相邻多项作为一个工作单元——成员逐项 claim/交付（每项仍是独立 Task 与验收单元），note 由负责人 `modify` 记录合并说明。
- 确认环节是流程与指引门槛（唤醒文案 + preset 指引），账本不强制"确认后才建子任务"（建子任务本就是成员现有权力）；账本强制的是成员无队列写权。

## 8. 模型工具

- 新工具 `team_queue`（加入 `tool-agent-team` 与 `team-member` preset，工具数 9 → 10，preset 指引同步更新）：
  - leader：`assign`（memberId + tasks[] + note[]? + atIndex?）、`insert`（同 assign 带 atIndex，或并入 assign）、`remove`（entryRef）、`modify`（entryRef + note）、`reorder`（memberId + entryRefs 全序）、`list`（任一成员队列）。
  - 普通成员：仅 `list`（自己的队列）。
  - 拒绝一律结构化（含 `queued_for`、`not_leader`、`entry_not_pending` 等），工具结果文本复述下一步建议（如"该任务已排入 @X 的队列"）。
- `team_view` 成员行增加队列长度字段（leader 一眼看到各成员积压；不展开内容，细节走 `team_queue list`）。
- preset 指引补一段队列行为守则：按队列逐项实施、开工前整体分析、合并/拆分先确认、不自行调整顺序、完成后 Host 会自动给出下一项。

## 9. Client UI（替换"任务队列"对话框）

- 入口不变：Agents 侧栏行菜单"任务队列"→ 对话框（标题仍 `任务队列：{name}`）。
- **正在处理**：working + awaiting 项（活跃 claim / 待验收），行含状态点、Task #N、主题、处理人标签（沿用现状）。
- **待开始**：队列有序项，行含序号、Task #N、主题、备注、安排人、时间；行点击跳转 Thread（沿用 `selectThread` 快照导航）。
- **逐项操作**（行菜单，均仅待开始项可用；working/awaiting 禁用并给原因提示）：**改派** / **移除** / **上移 / 下移**（相邻交换，即 reorder 的最小 UI）。
- **改派对话框**（替换旧征询式 TaskReassignDialog）：选目标成员（enabled、非 human/assistant）→ 提交 `queueReassign`；目标不在任务频道时提供"加入频道并入队"一步完成（先 join 后 reassign 两个请求，失败原位展示）。
- **追加任务**：对话框底部入口，从 workspace 内 open 且未入队的任务中选（数据用现有 `tasks` + `memberTasks` 读结果客户端过滤）→ `queueAssign` 追加队尾。
- 全部写操作**非乐观**：requestId 幂等、拒绝原位展示、提交后重读；沿用 `useEditDialogSave` / `changeTask` 模式。新 `@Remote` 方法（`queueAssign`/`queueAmend`/`queueReassign`）走 `npm run generate:typert` 重新生成声明。
- `memberTasks` 读远端保留名称、重构结果形状：`queues[]` 每成员 `{ memberId, entries（含派生 standing 与任务行）}`；旧 `current`/`queued` 字段与 `agentTasksQueued`（待领取）分区删除；`agentTasks*` locale 键组重写（zh/en 同步）。
- 加载/空/错误态沿用现有对话框模式；空队列文案指向"负责人或你在看板安排任务"。

## 10. 测试与验收面

- **ledger spec**：授权矩阵（Human/leader/归属成员/其他成员/assistant 全覆盖）、requestId 幂等重试、入队前提逐项校验、occupancy 拒绝与解除、改派原子性（源减目标增，任一前提失败整体拒绝）、reorder 全集校验、cleanup（accept/close/频道归档/成员归档移除离开）、旧账本重放一致（cleanup 载荷可选字段）。
- **唤醒 spec**：三个触发点时机、不可用成员只入箱不唤醒、release 跳过被释放项、通知含分析门槛语、fresh 成员经 claim 触发既有 reset。
- **工具 spec**：leader 动作全集、成员仅 list、结构化拒绝原因、`team_view` 队列长度字段。
- **client spec**：重写 `team-member-queue.client.spec.tsx`——队列视图渲染（正在处理/待开始/序号/备注/安排人）、改派调用与 join+reassign 组合、移除、上移/下移、追加任务、working 项禁用改派、空态。
- **browser journey**：`scripts/team-ui.e2e.ts` 更新；desktop + 390×844 截图自检，键盘/焦点与对话框可达性沿用现行检查单。

## 11. 否决方案

| 方案 | 否决原因 |
| --- | --- |
| 队列项为独立轻量 todo 实体（开工才建 Task） | 两套任务事实源，验收/看板/线程都要桥接，违反"单一权威投影"守则 |
| 队列项带独立状态机（与 Task/Claim 并行） | 状态重复推导必然漂移冲突 |
| 仅 Human / 仅 leader 管理队列 | 丢双轨中一侧：仅 Human 失去 leader agent 自动路由；仅 leader 在无 leader 团队时无人管理 |
| 逐项人工确认后才开下一项 | 与"逐个实施"自动化意图相悖；验收仍是每任务 Human accept，控制已足够 |
| 进行中项可改派（强制中断） | 硬停运行中回合复杂度高；先释放再转已覆盖场景 |
| 入队不占用（先到先得） | 队列可能被队列外抢单架空，"安排"失去路由意义 |

## 12. 不做什么

不做跨成员共享队列或任务池；不做队列项依赖图/DAG；不做自动优先级（时间/SLA 驱动重排）；不改 `team_claim` 现有语义（除占用拒绝）与 Task/验收流程；不改 `../deepseek-harness`；不改归档历史 `.scratch/` 材料。

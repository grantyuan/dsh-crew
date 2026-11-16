# 01 — Host 队列核心：实体、三个队列操作、占用与 Human Remote

**What to build:** 每个成员拥有一个持久有序的私有任务队列：Human 可以通过新的 Host 远端把开放任务安排进队列（追加/插入）、移除、改备注、重排，并把未开始的队列项改派给另一成员；任务被入队后其他成员认领会被结构化拒绝，队列归属成员正常认领；任务落定、频道归档、成员离职时引用它的队列项自动清除。本票全部由 ledger 测试验收，尚无模型工具与 UI（分别在票 02/03），UI 层仅 `memberTasks` 读投影重构到位。

**Blocked by:** None — can start immediately

**Status:** complete

- [ ] 新增队列项实体与每成员有序队列（≤20 项），entryRef 沿用现有 branded ref 铸造模式；形状与语义以 spec §3 为准（note ≤200、addedBy、addedAt）
- [ ] 三个新 ledger 操作（`team/queue-assigned`、`team/queue-amended`、`team/queue-reassigned`）按 spec §4 全量校验：入队前提（开放任务、status todo、未被任何队列引用、目标成员参与任务频道、队列上限）、amend 边界（remove/reorder 仅待开始项、reorder 须为当前集合排列）、改派原子性（源减目标增，任一前提失败整体拒绝；目标 enabled 非 human/assistant 且参与频道）
- [ ] 授权：Human actor（Remote 盖章路径）与 `leader: true` 成员可写队列；队列归属成员与其他成员无任何队列写操作；requestId 幂等重试返回原回执；拒绝均为结构化原因（含 `queued_for`、`entry_not_pending`、`already_queued`）
- [ ] occupancy：`claim` 对被任一队列引用的任务，非归属成员被拒（`queued_for` + 归属成员），归属成员正常；队列项移除/改派后占用解除
- [x] 清理：任务 resolution 落定（accept/close）、频道归档清除引用项；成员归档/移除/离开 workspace 清空其队列——实现为投影侧清除（沿用 watch 退役先例），cleanup 载荷不加快照，旧账本重放行为不变
- [ ] `memberTasks` 读投影重构：每成员返回队列 entries（含派生 standing：待开始/正在处理/待验收）与任务行信息；旧 `current`/`queued` 字段移除；新增 Human 写远端 `queueAssign`/`queueAmend`/`queueReassign` 并重新生成 typert 声明
- [ ] ledger spec 覆盖以上全部（授权矩阵含 assistant 与非参与 leader 的拒绝路径、幂等重试、重放一致）；`npm run test`、`npm run typecheck` 通过

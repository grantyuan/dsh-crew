# 04 — 维护文档收口与工作项归档

**What to build:** 队列功能的公开语义（工具、占用、授权、UI 行为）在维护文档与 CHANGELOG 中与代码一致，工作项关闭归档，`.scratch/README.md` 索引更新。完成后本仓库对使用者呈现完整的"负责人派工队列"能力说明。

**Blocked by:** 01、02、03

**Status:** complete

- [x] `docs/team-collaboration/tools.md`（与 .zh.md）：`team_queue` 动作面、入队占用语义、成员队列行为守则（逐项实施/开工前整体分析/合并拆分先确认/顺序由负责人管理）
- [x] `docs/architecture/host-authority.md`（与 .zh.md）：三个队列操作与 Human Remote 的授权矩阵、occupancy 拒绝、投影侧清理
- [x] `docs/team-collaboration/tools.md` 中"team_view 不是工作队列"的表述与队列长度字段的并存口径核对——`team_view` 行携带队列长度计数，内容仍在 `team_queue list`，地址簿口径不变
- [x] CHANGELOG `[Unreleased]` 增补两条（队列功能 + 对话框替换）；根 README 工具清单 12 → 13，`packages/tool-agent-team/README.md` 增 `team_queue` 条目与 `team_view` 队列长度说明
- [x] 浏览器验收截图中代表验收点的两张（队列对话框 desktop + 390×844）复制进本目录 `validation/`，README 注明证明点与复跑命令
- [x] 关闭未完成票据 → 本目录移入 `.scratch/archive/2026-11/member-task-queue/` → 更新 `.scratch/README.md` 索引（进行中/已归档计数）

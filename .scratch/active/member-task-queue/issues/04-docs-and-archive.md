# 04 — 维护文档收口与工作项归档

**What to build:** 队列功能的公开语义（工具、占用、授权、UI 行为）在维护文档与 CHANGELOG 中与代码一致，工作项关闭归档，`.scratch/README.md` 索引更新。完成后本仓库对使用者呈现完整的"负责人派工队列"能力说明。

**Blocked by:** 01、02、03

**Status:** ready

- [ ] `docs/team-collaboration/tools.md`（与 .zh.md）：`team_queue` 动作面、入队占用语义、成员队列行为守则（逐项实施/开工前整体分析/合并拆分先确认/顺序由负责人管理）
- [ ] `docs/architecture/host-authority.md`（与 .zh.md）：三个队列操作与 Human Remote 的授权矩阵、occupancy 拒绝、cleanup 快照
- [ ] `docs/team-collaboration/tools.md` 中"team_view 不是工作队列"的表述与队列长度字段的并存口径核对，避免自相矛盾
- [ ] CHANGELOG `[Unreleased]` 增补条目；相关 package README 如提 及工具清单（9 → 10）同步
- [ ] 浏览器验收截图中人工确认能代表验收点的少量代表图复制进本目录 `validation/` 并在 README 注明证明点与复跑命令
- [ ] 关闭未完成票据 → 本目录移入 `.scratch/archive/2026-11/member-task-queue/` → 更新 `.scratch/README.md` 索引（进行中/已归档计数）

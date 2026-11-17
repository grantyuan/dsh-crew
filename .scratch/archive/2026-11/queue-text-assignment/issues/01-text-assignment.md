# 01 — 文字直派：对话框双模式与 team_queue text 形态

**What to build:** Human 在「任务队列」对话框点「追加任务」后可直接切换「直接描述需求」：写一段需求/研究目标、选落点频道（默认成员已加入的第一个活跃频道），一次提交即原子建卡并入队——全程不需要先手工建卡。Leader 的 `team_queue assign` 接受 `text`（默认落点为与目标成员共同加入的第一个频道，`channelRef` 可改选），同样原子建卡入队。队列项仍一律引用真实 Task，占用/验收/自动接续全部不变。

**Blocked by:** None — can start immediately

**Status:** complete

- [x] 追加对话框双模式（从看板选卡 / 直接描述需求）：文字模式含需求输入与落点频道选择器（默认成员第一个活跃频道）；提交 = `sendMessage asTask` 原子建卡 → `queueAssign` 入队，两个既有持久操作，拒绝原位展示
- [x] `team_queue assign` 新增 `text` 与 `channelRef` 参数：text/taskRefs 互斥校验；默认落点为 leader 与成员共同加入的第一个活跃频道，无共同频道时结构化拒绝；卡片为 asTask start（leader 自身权限），入队拒绝时卡片留在看板可重试
- [x] locale 键组（zh/en 同步）：模式切换、文字模式文案、频道选择、完成态
- [x] client spec 新例：文字模式断言 `sendMessage(asTask)` 与 `queueAssign`（minted taskRef）两次调用与完成文案
- [x] 浏览器 journey 扩展：真实队列对话框内完成一次文字直派并断言新条目出现
- [x] 文档：`tools.md`(+zh) 两种形态与"卡片是副产品"口径、tool README、CHANGELOG；`npm run typecheck`、`npm run check:docs` 通过

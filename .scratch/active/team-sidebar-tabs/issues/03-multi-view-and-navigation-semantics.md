# 03 — 多开并览语义与页面行为打磨

**What to build:** 用户能真正「同时看多个功能界面」：不同频道/线程并排两个 pane 或浮动窗里各自独立工作；线程定位（focusSequence/来源高亮）从「快照 face 独占重放」改为按 tab 的 `navigation.revision` 逐次生效；workspace 切换时页面型 tab 重导航到新 workspace；页内跳转（线程里点频道 chip 等）在边栏语义下落到正确 tab。消息中心页确认以 `team-message-center` tab 形态工作（与 `active/message-center` 工作项的 P2 对齐，其页面逻辑不在本票范围）。

**Blocked by:** 02
**Status:** ready

设计口径见 [../spec.md](../spec.md) §5.2、§5.3、§6.2、§6.3。

## 需要钉住的语义

- 多开路径：对已开频道的另一频道地址 openResource ⇒ 新 tab（contentId 不同）；系统边栏 `split` 预算为 2 个 docked pane + 浮动窗（Harness 侧策略，Team 不绕过、不扩预算；超出记为限制）。频道 A 与线程 B 并排、或两个频道并排，是本期验收形态。
- 线程定位：`focusSequence`/`threadOrigin` 从导航快照输入改为 tab 自己的 `navigation.revision` 递增触发；同一线程被再次打开（reveal）也能重新定位。
- workspace 切换：页面型 tab 的 params 换 workspaceId 重导航（revision++）；地址型 tab 不受影响（各自带址）。
- 页内跳转：线程页 back/频道选择等，改为从 body 拿到的 tab actions（bindCommands/openResource）走边栏，而不是只动导航快照；导航快照继续只承担「最后站立界面」记忆。
- 会话归属确认：切中间栏会话时 tab 集合随系统边栏 per-session 保留走（VS Code 语义），Team 不额外持久化 tab 集合；进入团队模式的重放只补开快照 face 对应 tab。
- draft/keepMounted：线程草稿已有独立 localStorage store；评估频道/线程 body 是否设 `keepMounted`（切 pane 不丢滚动/本地态），按实测取舍并在票内记录结论。

## 实施切片

- [ ] 组件测试：两个不同频道地址先后 open 后各自渲染独立时间线；reveal 同址时 revision 递增触发重新定位断言。
- [ ] 线程 body 定位改造（revision 驱动）+ 页内跳转接 tab actions。
- [ ] `npm run test:browser`：桌面双频道并排截图、窄视口单栏截图检视；手动确认切会话/切回后 tab 恢复与草稿不丢。
- [ ] `npm run test`、`npm run typecheck` 通过；提交。

## 验收

- [ ] 能同时打开两个不同频道（或频道+线程）并排工作，滚动/草稿互不干扰
- [ ] 线程定位在 reveal 时也生效；来源（task/thread）高亮正确
- [ ] workspace 切换后页面型 tab 内容跟随；地址型 tab 不动
- [ ] 浮动窗开一个线程、docked pane 留频道，回到团队模式后不要求 Team 侧重建此布局（归系统边栏记忆）
- [ ] 不突破 2-pane 预算；若实测需要更多并览，记录为 Harness 限制而非绕过

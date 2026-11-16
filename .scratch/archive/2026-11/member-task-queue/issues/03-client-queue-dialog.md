# 03 — Client 队列对话框替换：改派/移除/重排/追加与浏览器验收

**What to build:** Human 点击 Agents 侧栏成员行菜单"任务队列"，看到该成员私有队列的全部任务（正在处理 + 待开始，含序号/备注/安排人），可对待开始项逐项改派、移除、上移/下移，并在对话框里把未入队的开放任务追加进队列；改派目标不在任务频道时可一步"加入频道并入队"。旧"待领取"分区与征询式转派对话框删除。

**Blocked by:** 01

**Status:** complete

- [x] "任务队列"对话框内容替换：正在处理（working + awaiting）与待开始（按队列序：序号、Task #N、主题、备注、安排人、时间）两个分区；行点击沿用快照导航跳转 Thread；加载/空/错误态沿用现有对话框模式，空队列文案指向"负责人或你在看板安排任务"
- [x] 逐项行菜单：改派/移除/上移/下移仅待开始项可用，进行中/待验收项禁用并展示原因提示；全部写操作非乐观（requestId 幂等、拒绝原位、提交后重读），沿用现有对话框保存模式
- [x] 改派对话框（替换征询式实现）：选目标成员（enabled、非 human/assistant）提交 `queueReassign`；目标不在任务频道时提供"加入频道并入队"（先 join 后 reassign，失败原位展示）
- [x] 追加任务入口：从 workspace 内 open 且未入队的任务中选（客户端用 `tasks` + `memberTasks` 读结果过滤）→ `queueAssign` 追加队尾
- [x] `agentTasks*` locale 键组重写（zh/en 同步，缺失/多余键编译报错）；旧 `agentTasksQueued`（待领取）相关键与征询式转派键清理
- [x] client spec 重写 `team-member-queue.client.spec.tsx`：队列渲染、改派调用与 join+reassign 组合、移除、上移/下移、追加任务、working 项禁用改派、空态
- [x] `npm run test:browser` 通过并检视 `artifacts/browser/` 截图（desktop + 390×844）：journey 新增真实队列对话框步骤（Host 真实入队 → 打开对话框 → 断言待开始/备注/安排人 → 双视口截图 → Escape 关闭）；键盘/焦点沿用 Modal/TeamRowMenu 原语；窄屏行自动折行（见归档 validation 截图）

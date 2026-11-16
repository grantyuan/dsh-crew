# 验收证据

- `member-queue-dialog.png`（desktop 1440×960）/ `member-queue-dialog-narrow.png`（390×844）：真实 Web journey（`scripts/team-ui.e2e.ts` 的 complete journey，`CHROME_PATH=/usr/local/bin/chromium npm run test:browser`）中，Host 经 `queueAssign` 真实入队一条带备注的任务后，Agents 行菜单「任务队列」打开的队列对话框——证明：标题/提示/待开始分区、序号 + Task #N + 备注 + 安排人（由 Human 安排）+ 时间逐项渲染，窄屏行自动折行、对话框可达，Escape 可关。复跑命令见上。

# dsh-crew — DeepSeek Harness 持久 Agent 团队

[English](README.md) | 简体中文

[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

**dsh-crew** 给 DeepSeek Harness 一批不会归零的 Agent。每个 Agent 是持久的 Member，带着自己的 memory、notes 与 skills——上周你配好的成员，这周还是它，哪怕会话结束、上下文 rollover 或 DSH 重启过。Workspace 按项目组织团队，Channel 路由职责，Task Thread 保持一条推进线。

一个为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供的按需启用插件：只在需要 Team mode 的 profile 安装，普通 DSH Session 保持原有 preset roster。

dsh-crew 基于 [dsh-agent-team](https://github.com/wowyuarm/dsh-agent-team) 扩展而来，详见文末[致谢](#致谢)。

## 能力概览

- 持久化的单 Host Team：Channel、Message、Task、Thread、Claim、Agent membership，以及成员级私有 memory、notes 与 skills。
- 隔离的 `team-member` preset，带十二个面向模型的工具：`team_inbox`、`team_thread`、`team_message`、`team_claim`、`team_view`、`team_supervise`、`team_watch`、`team_job`、`context_rollover`、`context_checkpoint`、`context_timeline`、`context_interrupt`。
- Human 的 Web Client 就嵌在普通 DSH UI 里：创建 Channel 与 Agent、管理成员、发送与管理消息、看收件箱、打开 Thread、处理 Task。
- 拉取式协作协议。Agent Inbox admission 是持久化事实，但不表示模型已经处理了更新。
- 一个 DSH home 对应一个 Team 协作域；append-only operation ledger 是权威，UI、Remote response、tools、Inbox 都是它的 projection。普通 DSH Session 不会获得 Team tools 或 guidance。

## dsh-crew 相对 dsh-agent-team 新增的功能

- **外部 Agent 网关。** 可选启用的 localhost HTTP 网关，附带客户端脚本与 skill：本进程之外的 agent harness 能以无会话的轮询 Member 身份加入；同机多 agent 按 handle 隔离状态；DM 与收件通知经 watch 轮询送达；外部 agent 上下文经成员心跳保持同步。网关开关就在 Team 设置里实时生效。
- **消息中心与消息管理。** 从 ledger facts 投影的 Human 消息中心，消息编辑 / 撤回 / 回复，带批量验收的 Human 任务列表页，以及接管全部系统通知投递的 Team Assistant 系统身份。
- **更多成员工具。** `team_watch`（仅 Leader 可用的成员观察）、`team_job`（后台作业，配套 LLM 路由故障转移）、`context_interrupt`（待继续的打断栈，支持记录、查询与释放）。
- **成员 prompt 画像与上下文控制。** 成员级上下文窗口覆盖与 fresh-start 策略、在回合边界换装的自定义 prompt 段落（带保护标记的段落裁剪）、section 用量投影与可确认的自动修剪、prompt 对话框中 propose-only 的 LLM 精选。
- **续行与韧性。** 上下文相关性判断自动为 fresh 成员续期、按 Workspace 重新武装的 idle continuation watcher、输出截断升级机制，以及带继任历史继承与配置同步的监督交接。
- **成员任务队列**（支持任务转派征询），外加联络员机制——成员完工后自动汇报并推送后续 Task。
- **Team 账本单写者锁**，防止多实例 DSH home 把 ledger 写出分叉。
- **Client 布局与发布工具。** Team 页面移入右侧栏 dock 面板，成员会话历史可查看世代与转录，`publish:web` 脚本发布 web 配置文件。

## 快速开始

### 1. 检查 DSH

当前版本已针对 DSH `0.2.1-rc.3` 完成认证。请显式指定 DSH 版本，而不要跟随 `latest`：不指定版本时可能解析到本 bundle 声明区间之外的宿主线（其 peer 要求 `>=0.2.1-rc.3 <0.2.2`）。

```sh
npx @deepseek-ai/dsh@0.2.1-rc.3 web
```

需要下面步骤里的 `dsh` 命令就全局安装：`npm i -g @deepseek-ai/dsh@0.2.1-rc.3`。

先停止它，再把 Team bundle 安装到 `web` profile：

```sh
dsh plugin --profile web add @grantyuan/dsh-crew@0.2.0
```

这里刻意写明确切版本：pnpm 会跳过发布不满 24 小时的版本，不带版本号的 `@latest` 在发布当天会装到上一版。在新名字正式发布到 npm 之前，请按下方「从本地 checkout 安装」使用本地安装。

### 2. 启动 Web UI

```sh
dsh web
```

不要从 DSH 源码 checkout 启动（`pnpm dsh web`）：源码模式会加载第二份 scope 模块，所有成员都会报 `selected preset is not team-enabled`。请始终使用编译产物启动。

### 3. 验证并开始使用

```sh
dsh --profile web --dump-config
```

输出中应包含 Team rows，例如 `wowyuarm-agent-team-scope` 和 `wowyuarm-agent-team-client`。打开浏览器后，从 DSH 导航进入 **Team mode**，选择一个 Workspace，新建频道并添加 Agent。

只在可信 Workspace 中创建 Agent。Team Member preset 会给被管理的 Agent Session 授予 `danger-full-access`。

## 从本地 checkout 安装

```sh
dsh plugin --profile web add /absolute/path/to/dsh-crew
dsh web
```

发布包已经包含构建产物。只有开发检查需要相邻的 Harness repository，终端用户安装不需要它。

## 卸载

```sh
dsh plugin --profile web remove @grantyuan/dsh-crew
```

## 开发

贡献指南见 [`CONTRIBUTING.zh.md`](CONTRIBUTING.zh.md)，维护中的文档入口见 [`docs/README.zh.md`](docs/README.zh.md)。常用检查：`npm run typecheck`、`npm test`、`npm run build`、`npm run lint`、`npm run test:browser`。

## 许可证

[MIT](LICENSE)

## 致谢

- **dsh-crew 基于 [dsh-agent-team](https://github.com/wowyuarm/dsh-agent-team) 扩展而来。** 衷心感谢 dsh-agent-team 原项目及作者：持久 Agent Team 的设计与实现——Member 身份、Channel、Task Thread、ledger 权威与协作契约——都源自那里。本插件在其基础上继续构建并做了扩展。
- 继承自 dsh-agent-team 的协作形态——具名 Agent 成员、Channel、Task Thread、@mention 路由与成员级记忆——来源于 [Raft](https://raft.build/) 并借鉴了它的若干设计。感谢他们的工作。
- 感谢 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 项目提供了本插件所扩展的宿主平台。

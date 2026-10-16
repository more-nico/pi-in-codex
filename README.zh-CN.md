# Pi in Codex

[English](README.md) · MIT 开源 · 首版 macOS

在 **当前 Codex 聊天** 的右侧面板中管理独立 pi 子对话。支持实时状态、
读取最近消息、运行中引导、排队跟进、停止、恢复，以及完成结果安全点回传。
同一项目中的不同聊天分别管理各自的子对话。

## 安装

需要 Node.js **22.19+**、已配置模型与认证的 **pi 1.2.0+**，以及支持 MCP Apps
会话面板、逐次调用 thread 元数据和插件 hooks 的 Codex 桌面客户端。
开发基准为 Codex **26.1013.31256** / pi **1.2.0**，完整桌面验收需在安装后完成。

```sh
npm ci
npm run check
node bin/pi-in-codex.mjs doctor
node bin/pi-in-codex.mjs install
```

也可解压发布 ZIP，在目录内执行 `node bin/pi-in-codex.mjs install`。
发布包已包含构建依赖，仍需用户自己的 Node 和 pi。

安装器复制到 `~/.codex/plugins/pi-in-codex`，合并更新
`~/.agents/plugins/marketplace.json`，并在修改前备份目录文件。
重启桌面应用，在本地插件来源中安装/启用 **Pi in Codex**，
**检查并信任它的 hooks**，然后开始新一轮对话。
从当前聊天的侧面板入口打开 **Pi agents**，也可以让 Codex 调用 `pi_panel`。
安装插件本身不会自动信任 hooks。

首版使用经本机验证的 `.codex-plugin/plugin.json` 兼容格式。安装器会为当前
安装位置解析 MCP 与 hooks 脚本路径，请通过安装器安装，不要直接复制源码模板。

隔离安装：`node bin/pi-in-codex.mjs install --codex-home /绝对路径/测试目录`。
对应 marketplace 位于该目录的 `.agents/plugins/marketplace.json`；
可用 `codex plugin marketplace add /绝对路径/测试目录` 将其加入客户端来源。

## 使用

例如：“用 pi 子 agent 检查认证模块，把必要背景传给它，然后继续这里的任务。”
插件附带技能会引导 Codex 调用这些工具：

| 工具 | 行为 |
|---|---|
| `pi_spawn` | 创建子对话，传入名称、任务、显式背景、目录和可选模型 |
| `pi_list` | 当前聊天的子对话与状态 |
| `pi_read` | 最近 N 条消息，默认 5、最多 200；可包含工具消息与未完成回复，支持 `before` 翻页 |
| `pi_send` | 默认运行中引导；`followUp` 为结束后跟进；已完成时恢复原对话 |
| `pi_stop` | 停止运行，保留历史 |
| `pi_wait` | 最多等待 60 秒，直到完成或需要输入 |
| `pi_ack` | 主对话读取完成结果后，确认其 completionId |

面板内部还使用 `pi_poll`、`pi_reply`、`pi_models`。子对话完成默认折叠，
失败和等待输入保持可见。面板中可发送消息、停止运行、回答 pi 扩展的交互请求。
模型参数为 `{ provider, id, thinking? }`；省略时使用 pi 默认配置。

## 回传与恢复

只有 `agent_settled` 表示本次运行完成。`agent_end`、提示接收成功、重试或
压缩都不会提前结算。恢复同一子对话时生成新的运行 ID，防止引用旧答案。

子任务完成后结果持久化保存。hooks 在主对话工具结束、结束当前轮或下一轮
开始时，向原聊天注入最后一条回复。主对话闲置时不会主动唤醒，待下一轮接收。
Stop hook 只为新结果触发续轮，不循环等待仍在运行的任务。
主对话通过 `pi_ack` 确认接收；未确认结果在后续轮次可再次提供，使用稳定 ID 去重。
过长回复提供预览，完整内容可用 `pi_read` 读取。失败、停止、中断均标记为部分结果。

默认并发 4 个，关闭面板或断开 MCP 后继续运行。完成的 pi 进程闲置 5 分钟后释放，
再次发消息时加载原会话。守护进程退出后，未完成任务标记为“已中断”，不自动重放。
升级/重新安装和卸载会先停止原守护进程，正在运行的任务因此中断。
等待输入的子对话也占用一个并发名额，回答请求或停止它后释放。

数据位于 `${CODEX_HOME:-~/.codex}/pi_in_codex`，含任务、消息与工具输出。
Unix socket 和数据文件限制为本地用户访问。认证仍由 pi 自己读取，不传给面板。
pi 使用自身工具与执行权限，并不继承 Codex 沙箱。子对话共享指定目录，需划分写入任务。

## 配置与诊断

- `PI_IN_CODEX_PI_PATH`：pi 可执行文件的绝对路径，默认通过 PATH 查找。
- `PI_IN_CODEX_NODE_PATH`：Node 路径，默认使用安装时记录的路径。
- `PI_IN_CODEX_DATA_DIR`：运行数据目录。
- `PI_IN_CODEX_CONCURRENCY`：并发数，默认 4，范围 1–32。
- `PI_CODING_AGENT_DIR`：沿用 pi 配置目录，默认 `~/.pi/agent`。

启动脚本将 Node 的 bin 目录和 Homebrew 路径加入 PATH。其他位置的 pi 请显式配置路径。
如果供应商认证通过环境变量提供，可补充 MCP 配置的 `env_vars`；pi 文件认证无需复制。
缺少当前会话元数据或 hooks 注册时会明确报错，不会按项目或最后活动窗口猜测归属。

```sh
node bin/pi-in-codex.mjs doctor
node bin/pi-in-codex.mjs daemon-stop
node bin/pi-in-codex.mjs uninstall
```

卸载仅删除带安装标记的插件目录及其 marketplace 条目，保留会话记录。
隔离安装卸载时同样传入 `--codex-home`。诊断日志为数据目录中的 `daemon.log`。

## 开发与发布

```sh
npm run check
npm run dev:ui
# 浏览 http://127.0.0.1:4173/?demo=1 查看带“演示数据”标记的面板
# /preview.html 对比 380px 浅色与深色侧栏
npm run pack:plugin
```

ZIP 输出到 `release/pi-in-codex-0.1.0-macos.zip`。
自动化测试通过确定性模拟 pi 验证真实 stdio、Unix socket 和 MCP 链路。
真实模型测试独立执行，会使用用户的模型订阅。
桌面面板挂载、hooks 信任和多窗口路由还需在安装后的实际客户端验收。
演示页面只用于界面验证，不代表真实任务或桌面集成测试。

含 hooks 的插件目前通过本地安装分发，不能提交到公共插件目录。
依据：[官方打包文档](https://developers.openai.com/plugins/build/plugins)。
复用代码与依赖许可证见 `THIRD_PARTY_NOTICES.md`、`dist/DEPENDENCY_NOTICES.txt`。

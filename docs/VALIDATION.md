# 首版验收记录

日期：2026-10-16（Asia/Shanghai）。本机 macOS，Node 24.15.0，pi 1.2.0，
Codex 桌面 26.1013.31256。以下明确区分自动化、真实运行时和桌面人工验收。

## 已验证

- `npm run check`：TypeScript 检查及 19 项测试通过。
- 两个聊天共享同一目录，不能跨聊天读取、发送、停止、回答交互或确认结果。
- 真实 stdio、Unix socket、MCP SDK 客户端和 hooks 进程组成的端到端链路通过。
- `agent_end` 后重试/压缩不误报完成；运行中引导、follow-up、停止、恢复均覆盖。
- 快速完成与排队输入相撞时，消息按序送达；启动拒绝时保留未确认送达的输入。
- pi 启动期间的交互可以回答；启动尚未完成时可以停止，无需等待握手超时。
- 分片中文、U+2028/U+2029、命令响应、provider 错误和进程异常均覆盖。
- 断开 MCP 后守护进程保留；重新连接可读取原记录；重启后未完成任务为中断状态。
- hooks 同轮不重复提供结果、后续轮重试未确认结果、确认操作可重复。
- 安装/重复安装/卸载保留其他 marketplace 条目；安装后的 bundle 不依赖 node_modules。
- 技能通过 skill-creator 的 `quick_validate.py` 检查。

## 真实 Codex 插件加载

`scripts/smoke-host.ts` 在隔离的 CODEX_HOME 中使用本机原生 Codex CLI：

1. 通过本项目安装器建立本地来源。
2. 原生 `plugin marketplace add`、`plugin list`、`plugin add` 成功。
3. 原生 app-server 发现 4 个 hooks、pi_in_codex MCP 服务和会话面板 thread entrypoint。
4. 插件自身启动配置完成 MCP 握手。
5. 未手工添加 thread 元数据的 `mcpServer/tool/call` 正确收到宿主提供的当前 thread 标识。

本机版本使用 `.codex-plugin/plugin.json` 兼容清单。安装器将脚本路径解析为
当前安装位置的绝对路径。便携清单在这个版本未能加载 hooks/MCP，因此未纳入发布包。
测试未修改用户现有配置，未启动模型轮次，临时目录在结束时删除。

## 真实 pi 与 DeepSeek Max

通过本机 CommandCode provider 的 `deepseek/deepseek-v4.1-flash-fast`，实际设置
`thinking: max`。禁用所有工具、扩展、MCP 和上下文文件发现：

- 第一轮收到 `PI_RPC_OK`，以 `agent_settled` 判定完成。
- 第二轮恢复同一 pi 会话，回复 `PI_RESUME_OK PI_RPC_OK`，确认保留前文。
- 两次运行 ID 不同，两个结果完成入队并分别确认。
- 独立代码复核促成了排队消息与快速完成边界的修复及回归测试。

脚本为显式调用的 `scripts/smoke-pi.ts`，不包含在常规测试内，以免意外消耗模型订阅。
`--quick` 执行短提示验证；省略该参数会进行一次独立运行层代码复核。

## 界面

通过应用内浏览器检查 380px 浅色/深色面板、已完成分组展开、交互请求响应和追加消息反馈。
预览使用显式标记的模拟数据。截图为 [panel-preview.jpg](panel-preview.jpg)。

## 开源发布审查

审查范围：Git 候选清单（45 个文件，含 intent-to-add 与未跟踪项）、`.gitignore`、
`package.json` 的 `files` 白名单、`scripts/package.mjs` 的 ZIP 清单、构建脚本、
README/验收文档、MIT 与第三方通知。

- 凭据与隐私：候选文件中 0 命中 API key、token、私钥、`.env`、个人主目录绝对路径
  （`/Users/...`、`/Volumes/...`）或运行时会话数据。`.mcp.json` 中列出的
  `*_API_KEY` 仅为环境变量名白名单，不含值；`?demo=1` 面板预览为显式标记的模拟数据。
- 本地产物隔离：`node_modules/`、`dist/`、`release/`（验收截图与 smoke 报告）、
  state/socket/PID/安装标记、归档与缓存均由 `.gitignore` 覆盖。
- 发布清单：`npm pack` 16 个文件；发布 ZIP 25 个条目；均不含运行数据、截图、
  smoke 报告或本机路径。
- 许可证：根 `LICENSE` 为 MIT，与 `package.json` 一致；`THIRD_PARTY_NOTICES.md`
  保留 tintinweb/pi-subagents 改编部分的 MIT 文本；22 个打包依赖（含 Apache-2.0 的
  `@modelcontextprotocol/client`/`core`）的完整许可证文本由 `scripts/build.mjs` 汇总到
  `dist/DEPENDENCY_NOTICES.txt`，随 npm 包与 ZIP 分发；相关依赖无 NOTICE 文件。
- 文档修复：`panel-preview` 实际为 JPEG，已由 `.png` 改名为 `.jpg` 并同步上方链接。

结论：未发现真实凭据或个人信息泄露，无发布阻断缺陷。

## 真实桌面验收（已完成）

在实际桌面会话中安装并信任插件 hooks 后重启客户端：

- Pi agents 会话面板成功挂载并显示“已连接”。
- 使用 DeepSeek Max（`deepseek/deepseek-v4.1-flash-fast`，`thinking: max`）连续执行
  两轮同一子会话：第一轮返回 `PI_IN_CODEX_OK` 并记住验证码，第二轮正确恢复上下文
  并返回验证码，两轮均正常完成。
- hooks 自动回传与 `pi_ack` 确认流程均已走通，本轮未出现失败计数。
- 证据截图与原始报告保留在已被 git 忽略的 `release/`，不进入 git、npm 包或发布 ZIP。

### 仍需人工验收

- 两个真实桌面窗口之间切换不同聊天，确认面板挂载和宿主路由。
- 长列表与大量消息的持续运行观察。
- GitHub Actions 远端工作流尚未执行（本地 `npm run check` 已通过）。

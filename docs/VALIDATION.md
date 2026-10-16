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

## 消息界面与长等待更新

- `npm run check`：类型检查与 36 项测试全部通过。
- `pi_wait` 必须显式指定 `timeoutMs`，范围 0–3,600,000 毫秒；socket 和 MCP
  超时预算一并延长。使用模拟 Pi 的真实 stdio/MCP/socket/hook 链路验证：传入
  60 分钟上限时，提前完成立即返回，最终回复进入原主对话的回传队列；未实际挂起一小时。
- 技能与工具说明要求创建或恢复任务前预估耗时，按预估选择等待时长。
- Markdown 的标题、GFM 表格/任务列表、代码块、链接及未完成流式文本通过渲染测试；
  原始 HTML、可执行链接与自动远程图片请求不会进入渲染结果。
- 网页预览验证 Markdown 表格、代码块、任务列表正常显示，无页面横向溢出；
  默认 50 条、手动历史分页、命令折叠及中性灰主题保留。
- 本次仅更新源码和本地网页预览，未更新用户已安装的插件。

## 只读面板与信息层级更新

- `npm run check`：类型检查与 39 项测试通过，包含当前运行总结与过程去重。
- 真实 MCP 链路验证主会话可调用 `pi_reply` 处理交互并继续任务；写入类工具仅对模型可见。
- 网页验证：默认仅总结、过程高度为零；展开有约 200ms 过渡且总结保留。
- 当前任务的耗时仅出现一次；列表浮层展开不改变任务标题位置，无横向溢出。
- 等待交互时面板仍没有可编辑输入控件；未固定时选择任务后列表关闭，回到已完成任务默认收起过程。
- 固定悬浮时，切换任务与点击正文均保持列表展开；手动折叠后重新打开保留固定状态，
  取消固定后恢复点击正文自动收起。网页操作验证通过，类型检查与构建通过。
- 信息规划见 [INTERFACE.md](INTERFACE.md)。本次仍未安装或提交。

## 子任务接口与协作更新

- 类型检查、构建和 52 项测试通过；新增覆盖报告/交互安全点通知、消息确认、旧结果游标、
  运行替换、等待全部、取消、闲置消息箱、软中断、按聊天公平排队、创建前模型查询、
  结果分页、归档与路径隔离、重试键和崩溃后的不确定投递。
- 扩展工具门禁测试验证 shell、写入、codemode 和未批准工具被拦截；桥接加载失败时，
  守护进程拒绝提交任务。工具限制不构成操作系统沙箱。
- 真实 MCP/stdio/socket/hooks 测试覆盖主会话模型查询、新工具可见性、重复创建去重和
  运行中消息回传。通信测试使用确定性的模拟 Pi，不调用付费模型。
- 本机 Pi 1.2.0 实际加载 dist/parent.mjs 并发出桥接就绪通知，get_state 成功；
  该检查没有提交模型任务。尚未在已安装 Codex 插件中验收这批改动。
- 旧数据库补齐邮箱和请求回执字段；运行中任务仍在重启后标记中断，不自动重放。

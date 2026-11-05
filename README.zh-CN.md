# MCP RepoBridge

> 一个带安全边界的 MCP 桥：让 LLM 读取项目上下文，在 Docker 沙箱中执行命令，按需使用文档型 Skill 和受信本地 MCP，并可选把实现任务交给 Codex。

[English](README.md)

MCP RepoBridge 可以让 ChatGPT 或其他 MCP client 连接到一个项目 workspace，
读取和搜索仓库内容，并在固定 Docker sandbox 中运行受限命令，而不是直接拿到宿主机 shell。

它不是一个完整 agent 框架，也不是要替代你的开发环境。它更像一座小桥：把 LLM 的交互界面、安全的项目上下文读取、Docker 沙箱执行，以及可选的 Codex handoff 串起来。

> [!IMPORTANT]
> **项目状态（2026 年 11 月）——预计为最后一个版本。** ChatGPT 与 Codex 的
> 使用额度将于 2026 年 12 月合并。届时额度共用，本项目存在的主要前提——
> "看项目走 ChatGPT、实现走 Codex"的额度拆分——不复存在，项目在 ChatGPT
> 下的实际价值也会随之降低。仓库会保持可用，但不再计划更新。

## 初衷

这个项目的出发点很实际：

- ChatGPT 网页适合交互式理解、提问、阅读代码和做轻量分析。
- Codex 更适合长时间实现、修改代码、跑任务。
- ChatGPT 和 Codex 的使用额度、交互方式并不完全一样，所以希望把“看项目”和“真正实现”拆开。
- 直接把本地 shell 暴露给远程 LLM 风险太大。

于是 MCP RepoBridge 做了一个中间层：

```text
ChatGPT / MCP client
        |
        | HTTPS + Bearer token
        v
MCP RepoBridge
        |
        |-- 宿主 workspace 只读文件工具
        |
        |-- 过滤后的临时副本 -> Docker sandbox 执行
        |
        |-- 可选文档型 Skill / 受信宿主 MCP 网关
        |
        |-- 可选 Codex 任务队列
```

ChatGPT 可以通过 MCP 看项目、搜代码、跑少量沙箱命令；如果你明确启用，ChatGPT 还可以把实现任务排队交给服务器上的 Codex worker。

## 能力范围

默认 MCP 工具：

```text
read_file
read_files
list_directory
grep_files
find_files
project_task_list
project_task_run
exec_container
sandbox_status
sandbox_start
sandbox_stop
sandbox_task_status
sandbox_task_tail
sandbox_task_cancel
workspace_bootstrap
workspace_info
audit_log_tail
```

可选 Codex handoff 工具：

```text
codex_task_create
codex_task_list
codex_task_status
codex_task_tail
codex_task_cancel
```

可选扩展工具：

```text
extension_discover
skill_read
mcp_call              # 只有明确启用宿主 MCP 执行后才暴露
```

明确不提供：

```text
run_shell
host_exec
write_file
edit_file
arbitrary_docker
```

## 安全模型

MCP RepoBridge 默认假设 MCP client 或模型可能提出不安全请求，所以安全边界写在代码里，而不是靠提示词约束。

关键默认行为：

- 不暴露宿主机 shell
- 不暴露宿主机写文件/编辑文件工具
- 文件访问限制在配置的 workspace root 内
- 拒绝路径穿越和 symlink 逃逸
- 默认阻止 `.env`、`.ssh`、`.aws`、`.gcloud`、`.secure-mcp` 等敏感路径
- 命令执行只能进入固定 Docker 容器
- 最终容器只接收过滤后的临时 workspace 副本；敏感路径不会复制进去，容器写入在停止后丢弃
- 模型不能选择 Docker flags、容器名、镜像、挂载路径
- 默认 Docker sandbox 使用 `--network none`
- 默认不挂载宿主机 HOME、SSH key、云凭据、Docker socket
- command policy 会拦截常见网络命令、Docker 命令、提权命令和危险删除命令
- HTTP transport 校验 Origin 和 Host allowlist
- HTTP MCP session 有上限和 idle TTL
- Codex worker 子进程只接收 allowlist 环境变量，并剔除 secret-like 变量名
- 扩展功能和宿主 MCP 执行使用两个独立、默认关闭的开关
- Skill 只作为不受信任的 Markdown 指令读取，不执行 Skill 脚本
- 宿主 MCP 的命令、参数、工作目录、环境映射和工具 allowlist 只能来自本地受信配置
- MCP 调用必须携带短时 discovery ID 和匹配的 schema 修订号
- 宿主 MCP 子进程有并发上限，并拒绝通配符工具权限
- 所有工具调用写入 audit log
- 所有工具结果使用稳定的 status/data/error/nextAction 信封

Docker 不是完美安全边界。这个项目做的是风险收敛，不是魔法护盾。公开 tunnel 前请阅读 [SECURITY.md](SECURITY.md) 和 [docs/06-threat-model.md](docs/06-threat-model.md)。

## 快速开始

安装依赖并构建：

```bash
npm install
npm test
npm run build
```

构建默认 sandbox 镜像：

```bash
docker build -f docker/Dockerfile.sandbox -t secure-mcp-sandbox:latest docker
```

为一个项目启动 bridge：

```bash
npm run --silent bridge -- start \
  --project-root /absolute/path/to/project \
  --tunnel none
```

停止：

```bash
npm run --silent bridge -- stop \
  --project-root /absolute/path/to/project
```

运行状态会写到：

```text
<project-root>/.secure-mcp/
```

这个目录里有 runtime config、Bearer token、日志、audit 记录和可选 Codex 任务状态。它已经被 `.gitignore` 忽略，并且会被文件工具视为敏感路径。

## 接入 ChatGPT

如果要让 ChatGPT 通过公网访问 MCP，需要启动 HTTP runtime 和 tunnel。

Cloudflare Quick Tunnel：

```bash
npm run --silent bridge -- start \
  --project-root /absolute/path/to/project \
  --tunnel cloudflare
```

自管 tunnel 或反向代理：

```bash
npm run --silent bridge -- start \
  --project-root /absolute/path/to/project \
  --tunnel external \
  --public-base-url https://mcp.example.com
```

启动后会输出：

```text
publicMcpUrl
token
```

ChatGPT 侧配置：

```text
URL: publicMcpUrl
身份验证: 访问令牌/API 密钥
标头方案: 持有者
Token: 只填 token 本体
```

最终 HTTP header 应该是：

```text
Authorization: Bearer <token>
```

如果 ChatGPT UI 已经选择了“持有者/Bearer”，token 输入框里不要再写 `Bearer ` 前缀。

Linux 服务器部署流程见 [docs/11-linux-server-tunnel.md](docs/11-linux-server-tunnel.md)。

更完整的中文操作指南见 [docs/12-中文使用指南.md](docs/12-中文使用指南.md)。

## Docker Sandbox

默认 sandbox 镜像基于 Node，包含：

```text
node
npm
bash
git
ripgrep
ca-certificates
util-linux
```

它不是完整多语言开发镜像。如果项目需要 Python、Go、Rust 或其他工具链，可以构建可信镜像，并通过本地配置选择：

```json
{
  "sandbox": {
    "image": "secure-mcp-sandbox:latest"
  }
}
```

不要允许 MCP client 或模型在调用时传入镜像名、Docker flags、挂载路径、网络模式或容器名。

在配置的 yield 时间内完成的命令会直接返回；长命令会转为持久化的
`sandbox_task_*` 任务，可增量读取日志并协作式取消。`project_task_list`
只暴露发现到的任务名称，不暴露 package script 正文；`project_task_run`
会在服务端解析任务，再经过原有命令策略执行。

## 可选 Skill 与本地 MCP

扩展网关默认关闭。它把本地 MCP/Skill 聚合器里比较顺手的“先发现、再调用”流程
接进 RepoBridge，但保留两层不同的信任边界：

- 文档型 Skill：扫描配置目录，限量返回 `SKILL.md`；不运行 Skill 自带的脚本或 runtime
- 本地 MCP：在宿主机启动受信配置中固定的 stdio 命令，发现 allowlist 内的工具，再代理带修订号的调用

复制 [examples/extensions.example.json](examples/extensions.example.json)，修改绝对路径和
allowlist，然后启动：

```bash
npm run --silent bridge -- start \
  --project-root /absolute/path/to/project \
  --tunnel none \
  --extensions-config /absolute/path/to/extensions.json
```

示例默认启用文档型 Skill，但仍保持 `hostMcpEnabled: false`。只有在逐项审查过
可执行文件、参数、工具 allowlist 和环境变量映射以后，才把它改成 `true`。

模型侧调用顺序：

```text
extension_discover(kind=skill) -> extension_discover(name=...) -> skill_read(revision=...)
extension_discover(kind=mcp)   -> extension_discover(name=...) -> mcp_call(discoveryId, revision, tool, arguments)
```

模型无法通过任何 MCP 工具传入进程命令、参数、cwd 或环境。环境变量值只能按本地
配置的变量名映射复制；audit 只记录上游参数名，不记录参数值。
上游工具元数据和调用结果都会明确标记为不受信任内容。

需要特别明确：启用的本地 MCP server 是受信任的宿主机原生程序。它继承
RepoBridge 进程的操作系统权限，不在 Docker sandbox 内。工具 allowlist 和环境
过滤限制的是模型能触达的表面，不能把恶意 MCP 可执行文件变成安全程序。

## 可选 Codex Handoff

Codex handoff 默认关闭。

启用后，ChatGPT 可以通过 MCP 创建结构化任务；另一个本地或服务器上的 worker 会领取任务，并调用 Codex 在 workspace 中执行。

启动 handoff 工具：

```bash
npm run --silent bridge -- start \
  --project-root /absolute/path/to/project \
  --tunnel none \
  --codex-handoff true
```

另开终端运行 worker：

```bash
npm run --silent codex-worker -- \
  --config /absolute/path/to/project/.secure-mcp/runtime.config.json
```

默认 worker 命令：

```text
codex exec --sandbox workspace-write --ask-for-approval never --json -
```

只有当你明确希望服务器上的 Codex 修改 workspace 时，才建议启用这个功能。MCP 请求本身只负责创建或查询任务记录。worker 子进程不会继承完整宿主环境，只会透传配置允许的安全变量，并剔除 secret-like 变量名。

任务创建支持幂等键，并记录相关文件与 Git 基线。worker 会发布心跳，默认在
相关文件发生上下文漂移时拒绝执行，支持取消运行中的任务，并在最终结果中记录
变更文件、任务前已有变更和 diff 摘要。

## 配置

配置模板：

```text
examples/config.example.json
examples/extensions.example.json
```

重要默认值：

- HTTP server 绑定 `127.0.0.1`
- sandbox network 为 `none`
- 真实 workspace 不挂载进最终沙箱；过滤后的临时副本可写，便于构建产生临时文件
- root filesystem 只读
- Linux capabilities 全部 drop
- 启用 `no-new-privileges`
- 配置 memory、CPU、PID、timeout、output 限制
- 默认启用 audit logging

为了减少 MCP 往返，建议客户端先调用 `workspace_bootstrap`。目录、搜索工具支持
不透明 cursor，`read_files` 有批量总预算；需要继续读取或补充运行条件时，工具
结果会给出结构化 `nextAction`。

## 开发

```bash
npm install
npm run lint
npm test
npm run build
```

可选 Docker e2e：

```bash
npm run test:e2e
```

该命令需要 Docker，只运行显式门控的 Docker sandbox e2e；普通 `npm test` 会跳过这组测试。

相关文档：

- [docs/03-architecture.md](docs/03-architecture.md)
- [docs/04-acceptance.md](docs/04-acceptance.md)
- [docs/05-review-checklist.md](docs/05-review-checklist.md)
- [docs/06-threat-model.md](docs/06-threat-model.md)
- [docs/10-codex-handoff.md](docs/10-codex-handoff.md)
- [docs/11-linux-server-tunnel.md](docs/11-linux-server-tunnel.md)
- [docs/12-中文使用指南.md](docs/12-中文使用指南.md)

## 状态

MCP RepoBridge 目前是早期 `0.1.x` 项目。核心 runtime、HTTP transport、Docker sandbox lifecycle、文档型 Skill/受信宿主 MCP 网关、bridge adapter 和可选 Codex handoff 流程已经可用。

它已经适合实验和个人工作流使用，但接口和部署建议仍可能随着更多真实项目测试而变化。

## License

Apache-2.0。见 [LICENSE](LICENSE)。

# MCP RepoBridge

> 一个带安全边界的 MCP 桥：让 LLM 读取项目上下文，在 Docker 沙箱中执行命令，并可选把实现任务交给 Codex。

[English](README.md)

MCP RepoBridge 可以让 ChatGPT 或其他 MCP client 连接到一个项目 workspace，
读取和搜索仓库内容，并在固定 Docker sandbox 中运行受限命令，而不是直接拿到宿主机 shell。

它不是一个完整 agent 框架，也不是要替代你的开发环境。它更像一座小桥：把 LLM 的交互界面、安全的项目上下文读取、Docker 沙箱执行，以及可选的 Codex handoff 串起来。

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
        |-- 只读项目文件工具
        |
        |-- Docker sandbox 命令执行
        |
        |-- 可选 Codex 任务队列
```

ChatGPT 可以通过 MCP 看项目、搜代码、跑少量沙箱命令；如果你明确启用，ChatGPT 还可以把实现任务排队交给服务器上的 Codex worker。

## 能力范围

默认 MCP 工具：

```text
read_file
list_directory
grep_files
find_files
exec_container
sandbox_status
sandbox_start
sandbox_stop
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
- 模型不能选择 Docker flags、容器名、镜像、挂载路径
- 默认 Docker sandbox 使用 `--network none`
- 默认不挂载宿主机 HOME、SSH key、云凭据、Docker socket
- command policy 会拦截常见网络命令、Docker 命令、提权命令和危险删除命令
- 所有工具调用写入 audit log

Docker 不是完美安全边界。这个项目做的是风险收敛，不是魔法护盾。公开 tunnel 前请阅读 [SECURITY.md](SECURITY.md) 和 [docs/threat-model.md](docs/threat-model.md)。

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

Linux 服务器部署流程见 [docs/linux-server-tunnel.md](docs/linux-server-tunnel.md)。

更完整的中文操作指南见 [docs/zh-CN-guide.md](docs/zh-CN-guide.md)。

## Docker Sandbox

默认 sandbox 镜像基于 Node，包含：

```text
node
npm
bash
git
ripgrep
ca-certificates
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

只有当你明确希望服务器上的 Codex 修改 workspace 时，才建议启用这个功能。MCP 请求本身只负责创建或查询任务记录。

## 配置

配置模板：

```text
examples/config.example.json
```

重要默认值：

- HTTP server 绑定 `127.0.0.1`
- sandbox network 为 `none`
- workspace 挂载模式为 `ro`
- root filesystem 只读
- Linux capabilities 全部 drop
- 启用 `no-new-privileges`
- 配置 memory、CPU、PID、timeout、output 限制
- 默认启用 audit logging

## 开发

```bash
npm install
npm run lint
npm test
npm run build
```

相关文档：

- [docs/architecture.md](docs/architecture.md)
- [docs/threat-model.md](docs/threat-model.md)
- [docs/codex-handoff.md](docs/codex-handoff.md)
- [docs/linux-server-tunnel.md](docs/linux-server-tunnel.md)
- [docs/zh-CN-guide.md](docs/zh-CN-guide.md)

## 状态

MCP RepoBridge 目前是早期 `0.1.x` 项目。核心 runtime、HTTP transport、Docker sandbox lifecycle、bridge adapter 和可选 Codex handoff 流程已经可用。

它已经适合实验和个人工作流使用，但接口和部署建议仍可能随着更多真实项目测试而变化。

## License

Apache-2.0。见 [LICENSE](LICENSE)。

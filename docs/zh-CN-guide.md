# MCP RepoBridge 中文使用指南

## 1. 这套工具解决什么问题

MCP RepoBridge 是一个面向 ChatGPT MCP 连接器的安全运行时。

它的目标不是把你的电脑完整暴露给 ChatGPT，而是只给 ChatGPT 一组很窄、可审计的能力：

```text
ChatGPT
  -> MCP HTTP 服务
    -> 只读读取项目文件
    -> 在固定 Docker 沙箱容器里执行命令
```

默认不提供：

```text
host shell
write_file
edit_file
任意 Docker 控制
```

也就是说，ChatGPT 可以看项目、搜索项目、在 Docker 沙箱里跑一些命令，但不能直接在宿主机上执行 shell，也不能直接改宿主机文件。

## 2. 推荐使用方式

推荐把服务跑在一台 Linux 服务器上，而不是跑在你的日常电脑或 WSL 里：

```text
ChatGPT 网页
  -> Cloudflare Tunnel / 反向代理
  -> Linux 服务器上的 127.0.0.1:8765/mcp
  -> MCP RepoBridge
  -> Docker sandbox
```

这样有几个好处：

- 你的个人电脑不需要暴露 tunnel。
- 工作区是服务器上的项目副本。
- Docker 沙箱也在服务器上。
- 测试完可以直接停掉服务、删掉 workspace。

## 3. 服务器准备

服务器建议安装：

```text
Linux
Docker Engine
Node.js 22+
npm
git
cloudflared 可选
```

拉取本项目并构建：

```bash
git clone <mcp-repobridge-repo-url>
cd mcp-repobridge

npm install
npm test
npm run build

docker build -f docker/Dockerfile.sandbox -t secure-mcp-sandbox:latest docker
```

准备给 ChatGPT 使用的项目 workspace：

```bash
mkdir -p "$HOME/mcp-workspaces"
git clone <your-project-repo-url> "$HOME/mcp-workspaces/project"
```

建议早期测试使用干净副本，不要直接拿生产目录试。

## 4. 启动 MCP 服务

### 4.1 使用 Cloudflare Quick Tunnel

如果服务器上安装了 `cloudflared`，可以直接启动：

```bash
npm run --silent bridge -- start \
  --project-root "$HOME/mcp-workspaces/project" \
  --tunnel cloudflare
```

成功后会输出类似：

```json
{
  "projectRoot": "/root/mcp-workspaces/project",
  "token": "xxxxxx",
  "localMcpUrl": "http://127.0.0.1:8765/mcp",
  "publicMcpUrl": "https://example.trycloudflare.com/mcp",
  "runtime": {
    "pid": 12345
  },
  "tunnel": {
    "mode": "cloudflare",
    "pid": 12346,
    "publicBaseUrl": "https://example.trycloudflare.com"
  }
}
```

其中最重要的是：

```text
publicMcpUrl
token
```

ChatGPT 侧就靠这两个值连接。

注意：`--tunnel cloudflare` 使用的是 Cloudflare Quick Tunnel，也就是临时的 `trycloudflare.com` 地址。它不会出现在 Cloudflare Dashboard 的 named tunnel 列表里，重启后 URL 也可能变化。

### 4.2 使用 Cloudflare Named Tunnel 或自管反向代理

如果你想在 Cloudflare 控制台里管理 tunnel，建议使用 named tunnel。

这时 Cloudflare 或你的反向代理应该转发到：

```text
http://127.0.0.1:8765
```

ChatGPT 实际使用的 URL 仍然要带 `/mcp`：

```text
https://mcp.your-domain.com/mcp
```

启动 runtime 时使用：

```bash
npm run --silent bridge -- start \
  --project-root "$HOME/mcp-workspaces/project" \
  --tunnel external \
  --public-base-url https://mcp.your-domain.com
```

这种方式更适合长期测试，因为域名固定，也能在 Cloudflare 后台管理。

## 5. ChatGPT 侧如何配置

在 ChatGPT 里添加 MCP 连接器时：

```text
URL:
publicMcpUrl
```

例如：

```text
https://example.trycloudflare.com/mcp
```

身份验证选择：

```text
访问令牌/API 密钥
```

标头方案选择：

```text
持有者
```

也就是英文里的：

```text
Authentication: Access token / API key
Header scheme: Bearer
```

token 输入框里只填 token 本体：

```text
xxxxxx
```

不要填：

```text
Bearer xxxxxx
```

因为选择“持有者/Bearer”后，ChatGPT 会自动生成：

```text
Authorization: Bearer xxxxxx
```

不要选择 OAuth，也不要选择 Basic。这个项目目前只实现 Bearer token。

## 6. 验证连接是否成功

服务器上可以先用 `curl` 测：

```bash
TOKEN='你的 token'
URL='你的 publicMcpUrl'

curl -i "$URL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0.0.0"}}}'
```

如果返回 `HTTP/2 200`，并且看到：

```text
serverInfo.name: mcp-repobridge
```

说明服务端、tunnel、token 都是通的。

如果没有 token 或 token 错误，应该返回 `401`。这说明认证层正在工作。

## 7. 在 ChatGPT 里怎么使用

连接器添加成功后，输入框里通常不会出现一个特殊按钮。你直接用自然语言要求 ChatGPT 调用工具即可。

建议先做几个轻量测试。

查看运行环境：

```text
请使用已连接的 MCP 工具调用 workspace_info，并把结果摘要给我。
```

列出项目根目录：

```text
请调用 list_directory，列出 workspace 根目录。
```

搜索文件：

```text
请调用 grep_files，在项目里搜索 README，最多返回 5 条结果。
```

查看沙箱状态：

```text
请调用 sandbox_status，告诉我 Docker sandbox 当前是否运行。
```

启动沙箱：

```text
请调用 sandbox_start 启动 Docker sandbox。
```

在沙箱里执行命令：

```text
请使用 exec_container 执行 pwd。
```

```text
请使用 exec_container 执行 rg --version。
```

停止沙箱：

```text
请调用 sandbox_stop 停止 Docker sandbox。
```

## 8. 当前可用工具

默认工具列表：

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

工具用途：

```text
read_file       读取 workspace 内的文件片段
list_directory  列出 workspace 内目录
grep_files      搜索文本内容
find_files      按 glob 查找文件
exec_container  在固定 Docker sandbox 中执行命令
sandbox_status  查看 sandbox 容器状态
sandbox_start   启动 sandbox 容器
sandbox_stop    停止 sandbox 容器
workspace_info  查看运行时配置摘要
audit_log_tail  查看最近审计日志
```

## 9. Docker 沙箱说明

默认 sandbox 镜像基于 Node，包含：

```text
node
npm
bash
git
ripgrep
ca-certificates
```

默认不包含：

```text
Python
Go
Rust
Java
```

如果以后要支持 Python、Go、Rust 等语言，建议构建受信任的本地镜像，例如：

```text
secure-mcp-sandbox-python
secure-mcp-sandbox-go
secure-mcp-sandbox-polyglot
```

然后只通过本地配置选择：

```json
{
  "sandbox": {
    "image": "secure-mcp-sandbox:latest"
  }
}
```

不要允许 ChatGPT 或 MCP 客户端传入镜像名、Docker 参数、挂载路径或网络设置。

## 10. 安全边界

这个项目的安全设计重点：

```text
不暴露 host shell
不暴露 write_file/edit_file
不允许模型选择 Docker 容器名
不允许模型选择 Docker 参数
不挂载 Docker socket
不挂载宿主机 HOME
不挂载 SSH key
不挂载云凭据
默认 Docker network none
默认 workspace 只读挂载
所有工具调用写入 audit log
```

Docker 不是完美安全边界，但它比直接给远程模型 host shell 安全得多。

## 11. Codex handoff 可选功能

默认情况下，ChatGPT 只能读取、搜索、沙箱执行，不能直接改代码。

如果你希望 ChatGPT 把“实现任务”排队交给服务器上的 Codex worker，可以启用 handoff：

```bash
npm run --silent bridge -- start \
  --project-root "$HOME/mcp-workspaces/project" \
  --tunnel cloudflare \
  --codex-handoff true
```

然后另开一个服务器终端：

```bash
npm run --silent codex-worker -- \
  --config "$HOME/mcp-workspaces/project/.secure-mcp/runtime.config.json"
```

启用后会额外暴露：

```text
codex_task_create
codex_task_list
codex_task_status
codex_task_tail
codex_task_cancel
```

这个模式下，MCP 请求只负责创建任务；真正执行代码修改的是你显式启动的本地/服务器 Codex worker。

早期测试建议先不要启用 handoff。等只读和 Docker 沙箱链路稳定后，再考虑打开。

## 12. 常用管理命令

查看状态：

```bash
npm run --silent bridge -- status \
  --project-root "$HOME/mcp-workspaces/project"
```

停止 runtime 和 tunnel：

```bash
npm run --silent bridge -- stop \
  --project-root "$HOME/mcp-workspaces/project"
```

轮换 token：

```bash
npm run --silent bridge -- rotate \
  --project-root "$HOME/mcp-workspaces/project"
```

轮换 token 后，需要在 ChatGPT 连接器配置里更新 token。

## 13. 如何关闭或禁用

关闭时建议按这个顺序做：先停服务器进程，再禁用 ChatGPT 侧连接器。这样即使 ChatGPT 里还留着配置，公网 URL 也已经无法访问。

### 13.1 临时关闭 runtime 和 tunnel

在服务器上执行：

```bash
npm run --silent bridge -- stop \
  --project-root "$HOME/mcp-workspaces/project"
```

这个命令会停止：

```text
MCP RepoBridge HTTP 服务
cloudflared Quick Tunnel 进程
```

如果你使用的是 Cloudflare Quick Tunnel，停止后临时 `trycloudflare.com` 地址会失效。

确认状态：

```bash
npm run --silent bridge -- status \
  --project-root "$HOME/mcp-workspaces/project"
```

如果看到 `running: false`，说明 runtime 已经停止。

也可以检查进程：

```bash
ps aux | grep -E 'dist/index|cloudflared' | grep -v grep
```

### 13.2 停止 Docker sandbox

如果 sandbox 容器还在运行，可以先查看：

```bash
docker ps -a | grep secure-mcp
```

默认容器名是：

```text
secure-mcp-sandbox
```

停止并删除容器：

```bash
docker rm -f secure-mcp-sandbox
```

如果你在配置里改过 `sandbox.containerName`，请使用实际容器名。

### 13.3 在 ChatGPT 里禁用连接器

如果只是自己测试，可以在 ChatGPT 的连接器或应用设置里 disconnect/disable 这个 MCP app。

如果你是 workspace admin，可以在工作区应用管理里：

```text
Disable app
Remove app
Restrict user access
Unpublish draft/published app
```

具体入口名称会随 ChatGPT UI 调整，但原则是：关闭 app 访问权限后，用户侧就不能再调用这个 MCP 连接器。

### 13.4 token 泄露或不再信任时

如果 URL 或 token 被贴到了不该出现的地方，先停服务：

```bash
npm run --silent bridge -- stop \
  --project-root "$HOME/mcp-workspaces/project"
```

然后轮换 token：

```bash
npm run --silent bridge -- rotate \
  --project-root "$HOME/mcp-workspaces/project"
```

轮换后，旧 token 会失效。重新启动后，需要把新 token 更新到 ChatGPT 连接器配置里。

### 13.5 彻底清理运行状态

如果确定不再使用这个 workspace 的 MCP 状态，可以删除：

```bash
rm -rf "$HOME/mcp-workspaces/project/.secure-mcp"
```

这个目录包含：

```text
bridge-state.json
runtime.config.json
token
runtime 日志
cloudflared 日志
audit 日志
Codex handoff 任务队列
```

删除前确认不需要保留审计日志。

## 14. 日志位置

运行状态、配置和日志都在项目 workspace 的 `.secure-mcp/` 目录：

```text
<project-root>/.secure-mcp/
```

常见文件：

```text
bridge-state.json
runtime.config.json
runtime.out.log
runtime.err.log
cloudflared.out.log
cloudflared.err.log
audit.log
```

查看日志：

```bash
tail -f "$HOME/mcp-workspaces/project/.secure-mcp/runtime.err.log"
tail -f "$HOME/mcp-workspaces/project/.secure-mcp/runtime.out.log"
tail -f "$HOME/mcp-workspaces/project/.secure-mcp/cloudflared.err.log"
tail -f "$HOME/mcp-workspaces/project/.secure-mcp/cloudflared.out.log"
tail -f "$HOME/mcp-workspaces/project/.secure-mcp/audit.log"
```

`.secure-mcp/` 里包含 token、状态、日志，不要提交到 git。

## 15. 常见问题

### pnpm 启动时报 Unexpected argument: start

推荐使用 npm：

```bash
npm run --silent bridge -- start \
  --project-root "$HOME/mcp-workspaces/project" \
  --tunnel cloudflare
```

当前脚本按 npm 的参数转发方式验证过。pnpm 对 `--` 的处理可能不同，导致脚本收到多余参数。

### ChatGPT 连接失败，但 curl 成功

大概率是 ChatGPT 侧认证方式没选对。

应该选择：

```text
身份验证：访问令牌/API 密钥
标头方案：持有者
token：只填 token 本体
```

不要选择 OAuth，不要选择 Basic，不要在 token 框里额外写 `Bearer`。

### 工具列表能加载，但输入框里看不到按钮

这是正常的。ChatGPT 通常不会在输入框里显示 MCP 工具按钮。

直接说：

```text
请使用 MCP 工具调用 workspace_info。
```

或者：

```text
请调用 list_directory 查看项目根目录。
```

### Cloudflare URL 没出现在 Cloudflare 后台

如果你用的是：

```bash
--tunnel cloudflare
```

它启动的是 Quick Tunnel，会生成临时 `trycloudflare.com` URL，不会出现在 Dashboard 的 named tunnel 列表里。

如果想在 Cloudflare 后台管理，使用 named tunnel，然后用：

```bash
--tunnel external --public-base-url https://mcp.your-domain.com
```

### 重启后 ChatGPT 连不上

Quick Tunnel 重启后 URL 可能变化。重新运行：

```bash
npm run --silent bridge -- status \
  --project-root "$HOME/mcp-workspaces/project"
```

确认 `publicMcpUrl` 是否还是 ChatGPT 里配置的那个。

### Docker sandbox 启动失败

确认镜像存在：

```bash
docker images | grep secure-mcp-sandbox
```

没有的话重新构建：

```bash
docker build -f docker/Dockerfile.sandbox -t secure-mcp-sandbox:latest docker
```

确认当前用户能使用 Docker：

```bash
docker ps
```

## 16. 建议的第一次完整测试流程

1. 服务器上启动：

```bash
npm run --silent bridge -- start \
  --project-root "$HOME/mcp-workspaces/project" \
  --tunnel cloudflare
```

2. 用 curl 测 `initialize` 返回 200。

3. ChatGPT 添加连接器：

```text
URL = publicMcpUrl
认证 = 访问令牌/API 密钥
标头方案 = 持有者
token = token 本体
```

4. 在 ChatGPT 里请求：

```text
请调用 workspace_info。
```

5. 请求：

```text
请调用 list_directory 查看项目根目录。
```

6. 请求：

```text
请调用 sandbox_start。
```

7. 请求：

```text
请使用 exec_container 执行 pwd。
```

8. 测试结束后停止：

```bash
npm run --silent bridge -- stop \
  --project-root "$HOME/mcp-workspaces/project"
```

这条链路跑通后，说明 ChatGPT、Tunnel、MCP runtime、Docker sandbox 四段都正常。

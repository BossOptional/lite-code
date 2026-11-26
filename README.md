# T3 Lite

一个给自己用的轻量 agent 控制台：**Pi + daemon + 浏览器/PWA + 可选 relay**。

- 不是 T3 Code 的 fork，也不依赖 Electron。
- 服务端是一个 Node 进程 + 一个 SQLite 文件；前端是三个静态文件。
- 每个线程一个 git worktree；每轮结束能看 diff。
- 可以直接跑在 Linux 服务器上，通过 relay 从手机/另一台电脑连回来。

## 快速开始（本机 mock）

```bash
npm install
T3LITE_MOCK=1 node src/server.js
# 打开 http://127.0.0.1:4317
```

Mock 模式不会调用模型，用来调 UI。

## 接真实 Pi

要求：

- Node.js 22+（本机测试用 24）
- `pi` 已安装并在 PATH 里，且已经 `/login`
- git

```bash
node src/server.js
# 打开 http://127.0.0.1:4317，新建项目（填一个 git 仓库的绝对路径），新建线程
```

环境变量：

| 变量 | 默认 | 作用 |
|---|---|---|
| `PORT` | `4317` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址；局域网用 `0.0.0.0` |
| `T3LITE_HOME` | `~/.t3lite` | SQLite + worktrees 的位置 |
| `PI_BIN` | `pi` | Pi 可执行文件路径 |
| `PI_HOME` | 空 | 给 Pi 子进程指定 HOME（隔离安装/测试用） |
| `T3LITE_MOCK` | `0` | `1` 时用 mock agent |

T3 Lite 直接说 **Pi RPC**（`pi --mode rpc`），不经过 `pi-acp`。原因：Pi RPC 有 `switch_session`、`fork`、`get_entries`、`get_session_stats`、`extension_ui_request`，这些是 ACP 适配器目前没有完整暴露的；少一层，也少一个会漂移的依赖。

### 审批与沙箱

Pi 核心**默认不会逐条审批工具调用**（见 [Pi Security](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md)）。T3 Lite 的审批卡片来自 Pi 的 `extension_ui_request`，所以需要装一个会发审批请求的 Pi 扩展：

```bash
pi install npm:pi-permission-modes
```

它会提供 Default / Plan / Build / YOLO 四种模式，把 `bash`/`edit`/`write` 的 allow/ask/deny 策略和 OS 沙箱（bubblewrap / sandbox-exec / Windows backend）绑在一起。审批请求会通过 `ctx.ui.confirm/select` 发到 T3 Lite，变成手机上的按钮。

如果你不想装扩展，Pi 会按自己的设置直接跑工具，T3 Lite 只负责展示。

## 部署到 Linux 服务器

```bash
# 服务器上
git clone <your repo> t3lite && cd t3lite
npm install --omit=dev
node src/server.js
```

systemd 示例 `/etc/systemd/system/t3lite.service`：

```ini
[Unit]
Description=T3 Lite
After=network.target

[Service]
User=you
WorkingDirectory=/home/you/t3lite
Environment=HOST=127.0.0.1
Environment=PORT=4317
Environment=RELAY_URL=wss://relay.example.com
Environment=RELAY_TOKEN=change-me
Environment=T3LITE_SERVER_ID=my-linux-box
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now t3lite
journalctl -u t3lite -f
```

> Pi 的登录态在运行服务的用户下。先 `sudo -u you pi /login`，或用该用户跑一次 `pi`。

## Relay：从手机连回 NAT 后的 Linux 服务器

拓扑：

```
手机/浏览器  ──wss──►  relay (VPS, TLS)  ◄──wss──  t3lite daemon (Linux, 无公网)
```

daemon 主动向外连 relay，所以服务器不需要公网 IP / 端口映射。

### 1. 在 VPS 上跑 relay

```bash
RELAY_PORT=4400 RELAY_TOKEN=change-me node relay/relay.js
```

生产环境建议放在 Caddy/nginx 后面，用 `wss://`：

```
relay.example.com {
  reverse_proxy 127.0.0.1:4400
}
```

### 2. daemon 配置与配对

```bash
RELAY_URL=wss://relay.example.com \
RELAY_TOKEN=change-me \
T3LITE_SERVER_ID=my-linux-box \
node src/server.js
```

然后生成配对链接（在 daemon 机器上）：

```bash
RELAY_URL=wss://relay.example.com node src/pair.js
```

它会打印：

```
https://relay.example.com/#offer=...
```

手机打开这个链接。`#offer` 是 URL fragment，浏览器不会把它发给 relay。

### 3. 配对与 E2EE

- daemon 首次启动生成持久 X25519 密钥对：`~/.t3lite/daemon-key.json`（0600）。
- 配对链接的 fragment 里是 `{relay, server, daemon public key, exp}`；不包含私钥。
- 客户端用一次性 X25519 密钥与 daemon 做 ECDH，HKDF-SHA256 派生 AES-256-GCM key；握手双方互相验证，之后每条消息加密并带递增计数器。
- relay 只看到 IP、连接时间、消息大小和密文；无法读取或篡改内容。
- 链接就是 trust anchor：谁拿到链接谁就能连 daemon（和 Paseo 一样）。默认 24 小时过期，`T3LITE_PAIR_TTL_MS` 可调。
- relay 层的 `hash = sha256("t3lite-pair:" + daemonPublicKey)` 只是路由门禁，不是安全边界；真正的认证是 E2EE 握手。
- 撤销所有设备：删除 `~/.t3lite/daemon-key.json` 并重启 daemon，旧链接全部失效。
- 在 daemon 本机也可以 `GET /api/pair` 生成链接。

### 用 Cloudflare 做 relay（推荐）

仓库里已经带了 Workers + Durable Objects 版本：`relay-cloudflare/` + `wrangler.toml`。

为什么适合：

- daemon 主动外连，Cloudflare 边缘做 WebSocket 终止，不需要自己的 VPS；
- 每个 `T3LITE_SERVER_ID` 一个 Durable Object，WebSocket 用 **Hibernation API**，空闲时不收 duration 费用；
- Workers **免费计划**就支持 SQLite-backed Durable Objects（100,000 requests/day、13,000 GB-s/day），个人用基本免费；
- 静态 UI 由同一个 Worker 的 Assets 托管，手机打开一个 URL 就行。

部署：

```bash
npm install -D wrangler
npx wrangler login
npx wrangler secret put RELAY_TOKEN     # 输入一个随机串
npx wrangler deploy
```

本仓库的 `wrangler.toml` 已经配好自定义域名：

```toml
routes = [
  { pattern = "lite.agentx1.com", custom_domain = true }
]
```

部署时 Wrangler 会自动创建 DNS 记录和证书。当前线上地址：

```
https://lite.agentx1.com
```

daemon 配置：

```bash
RELAY_URL=wss://lite.agentx1.com RELAY_TOKEN=<你刚设置的串> T3LITE_SERVER_ID=my-linux-box node src/server.js
```

然后在 daemon 机器上生成配对链接：

```bash
RELAY_URL=wss://lite.agentx1.com node src/pair.js
```

打开打印的 `https://lite.agentx1.com/#offer=...` 即可。

换成你自己的域名：改 `wrangler.toml` 里的 `routes`，确保域名在同一个 Cloudflare 账号下，然后重新 `wrangler deploy`。

在手机打开它即可。UI 由 Worker 的 `ASSETS` 直接提供。

本地调试：

```bash
cp .dev.vars.example .dev.vars
npx wrangler dev
# 另一个终端
RELAY_URL=ws://127.0.0.1:8787 RELAY_TOKEN=dev T3LITE_SERVER_ID=dev node src/server.js
```

注意：

- `wrangler.toml` 的 `[assets] run_worker_first` 只把 `/daemon`、`/client`、`/health` 交给 Worker，其余静态文件由 Assets 直接服务。
- `RELAY_TOKEN` 没设置时 relay 不校验 daemon；生产环境务必设置。
- 免费额度用完会直接失败（不会自动扣费），适合个人；团队用建议开 Workers Paid 或继续用自托管 relay。

## 数据

```
~/.t3lite/
├── t3lite.sqlite      # projects / threads / items / settings
└── worktrees/         # 每个线程一个 git worktree
```

线程的 `items` 是 append-only 事件流：user_message、agent_message、tool_call、tool_result、permission、error。刷新页面、重启 daemon 都不会丢。

重启后：

- 历史从 SQLite 读；
- 下一次发消息时重新拉起 `pi --mode rpc`，用 `switch_session` 接回原来的 Pi session 文件。

## 现在的功能

- 项目 / 线程 / 每线程 worktree
- Pi 流式消息、工具卡片、工具结果
- Pi `extension_ui_request` → 审批卡片（confirm/select/input/editor）
- diff 查看（`git diff` + `git status`）
- 停止当前回合
- token / cost（来自 Pi `get_session_stats`）
- 手机布局
- relay（daemon ↔ relay ↔ 浏览器）

## 还没做（按优先级）

1. **每设备密钥 / 撤销**：现在只有 daemon 持久密钥；撤销单个设备需要轮换 daemon key（会让所有设备失效）。
2. **审批体验**：现在只转发 Pi 扩展发来的 dialog；下一步做"默认模式"选择、记住本次会话的 allow，以及审批超时。
3. **多 agent**：Claude Code / Codex 通过 ACP adapter 接进来（保留 `Agent` 接口）。
4. **终端 tab**：xterm.js + PTY（需要 `node-pty`，v1 再说）。
5. **commit / push / PR**：`git` + `gh`。
6. **通知**：审批/完成时推 ntfy / Telegram / 飞书。
7. **线程重命名 / 删除 UI**、搜索、分页。

## 目录

```
src/
  server.js        HTTP + WebSocket + Pi 事件循环
  db.js            SQLite（node:sqlite）
  pi-agent.js      Pi RPC 客户端（JSONL）
  mock-agent.js    mock
  worktree.js      git worktree / diff
  relay-client.js  daemon 侧的 relay 客户端 + 虚拟 socket
public/
  index.html app.js style.css
relay/
  relay.js         WS relay（daemon/client 配对 + 通道复用）
```

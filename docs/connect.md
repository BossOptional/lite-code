# 从另一台电脑 / 手机连接你的 T3 Lite

这份文档只讲一件事：**daemon 跑在 A 电脑（Linux 服务器 / Mac mini），你从 B 电脑或手机连上去操作 Pi。**

先给结论：

| 场景 | 推荐方式 | 需要公网 IP | 加密 |
|---|---|---|---|
| 手机/外网连家里的服务器 | **Cloudflare relay + 配对链接** | 不需要 | 端到端加密（X25519 + AES-GCM） |
| 两台设备都在 Tailscale | **Tailscale 直连** | 不需要 | Tailscale（WireGuard） |
| 同一 Wi-Fi / 局域网 | **局域网直连** | 不需要 | 无（仅限可信网络） |
| 只想本机用 | `http://127.0.0.1:4317` | 不需要 | 无（本机） |

> 下面默认项目目录是 `~/lite-code`，daemon 数据目录是 `~/.t3lite`。你可以换成自己的路径。

---

## 0. 主机准备（A 电脑）

要求：

- Node.js 22+（推荐 24）
- git
- `pi` 已安装并登录（`pi /login`）
- 项目代码：

```bash
git clone https://github.com/BossOptional/lite-code.git
cd lite-code
npm install
```

先确认 daemon 能起来：

```bash
T3LITE_MOCK=1 node src/server.js
# 另开终端
curl http://127.0.0.1:4317/api/health
```

看到 `{"ok":true,"mock":true}` 就说明基础环境没问题。`Ctrl-C` 停掉。

真实使用：

```bash
pi /login          # 只需要一次
node src/server.js
```

浏览器打开 `http://127.0.0.1:4317`，建项目（填一个 git 仓库的绝对路径）、建线程，发一条消息，确认 Pi 能工作。

---

## 1. 方式 A：Cloudflare relay（推荐）

适合：手机在外网、服务器在 NAT 后面、不想开端口、不想装 VPN。

拓扑：

```
手机/另一台电脑  ──wss──►  Cloudflare Worker + Durable Object  ◄──wss──  t3lite daemon
                              （只转发密文）
```

### 1.1 部署 relay（只做一次）

如果你已经部署过自己的 relay（例如本仓库作者使用的 `https://lite.agentx1.com`），可以跳过这步，只需要拿到自己的 `RELAY_TOKEN`。

如果你不是这个 relay 的 owner，请部署自己的 Worker，不要使用别人的 relay 或 token：

```bash
npm install -D wrangler
npx wrangler login
npx wrangler secret put RELAY_TOKEN     # 输入一个随机串，记下来
npx wrangler deploy
```

`wrangler.toml` 里已经配好自定义域名：

```toml
routes = [
  { pattern = "lite.agentx1.com", custom_domain = true }
]
```

换成你的域名，确保 `agentx1.com` 这个 zone 在同一个 Cloudflare 账号下，然后重新 `wrangler deploy`。Wrangler 会自动建 DNS 记录和证书。

部署成功后会输出自定义域名。验证：

```bash
curl https://lite.agentx1.com/health
# {"ok":true,"relay":"lite-code"}
```

### 1.2 启动 daemon

```bash
cd ~/lite-code
RELAY_URL=wss://lite.agentx1.com \
RELAY_TOKEN='你的 relay token' \
T3LITE_SERVER_ID=my-linux-box \
node src/server.js
```

参数说明：

| 变量 | 作用 |
|---|---|
| `RELAY_URL` | Worker 的 `wss://` 地址 |
| `RELAY_TOKEN` | 和 `wrangler secret put RELAY_TOKEN` 设置的一致 |
| `T3LITE_SERVER_ID` | 这台机器的名字；同一个 ID 会替换旧连接 |
| `PORT` / `HOST` | 本地 HTTP，默认 `127.0.0.1:4317` |
| `T3LITE_HOME` | 数据目录，默认 `~/.t3lite` |

日志出现：

```
relay: wss://lite.agentx1.com server=my-linux-box
pair: node src/pair.js   (or GET /api/pair on localhost)
```

就说明 daemon 已经主动连上 relay。

### 1.3 生成配对链接

在 **daemon 同一台机器、同一个用户、同一个 `T3LITE_HOME`** 下：

```bash
RELAY_URL=wss://lite.agentx1.com node src/pair.js
```

输出：

```
Pair this device (open on your phone):

https://lite.agentx1.com/#offer=eyJ2IjoxLCJyZWxheSI6IndzczovL2xpdGUuYWdlbnR4MS5jb20i...
```

也可以在本机（daemon 所在机器）用：

```bash
curl http://127.0.0.1:4317/api/pair
```

### 1.4 手机连接

1. 手机打开上面的 `https://.../#offer=...`。
2. 页面会先做 E2EE 握手，然后自动连上 daemon。
3. 在 Safari/Chrome 里选“添加到主屏幕”，下次像 App 一样打开。

连接成功后：

- 左上角显示 `pi · relay`；
- 底部状态是 `已连接 · E2EE`；
- 线程列表来自 daemon；
- 发消息、审批、diff 都走加密通道。

> `#offer` 是 URL fragment，浏览器不会发给 Cloudflare；Cloudflare 只看到密文。

### 1.5 从另一台电脑连接

同一台 daemon，同一个配对链接，直接在另一台电脑的浏览器打开即可。每台设备会各自生成临时 X25519 密钥，互不影响。

---

## 2. 方式 B：Tailscale 直连

适合：你和服务器都在自己的 tailnet 里，不想经过 Cloudflare。

### 2.1 安装 Tailscale

服务器和手机/电脑都安装 Tailscale，登录同一个账号。

```bash
# 服务器
tailscale ip -4
# 例如 100.101.102.103
```

### 2.2 让 daemon 监听 Tailscale 地址

```bash
HOST=0.0.0.0 PORT=4317 node src/server.js
```

或者只绑 Tailscale IP：

```bash
HOST=100.101.102.103 PORT=4317 node src/server.js
```

### 2.3 连接

手机/电脑连上 Tailscale 后，打开：

```
http://100.101.102.103:4317
```

这是“本地模式”，没有 E2EE，但流量在 Tailscale 的 WireGuard 隧道里。

> ⚠️ 不要在没有 Tailscale / 防火墙保护的情况下把 `HOST=0.0.0.0` 暴露到公网。当前本地 UI 没有登录密码。

---

## 3. 方式 C：同一局域网

适合：临时在同一个 Wi-Fi 下，且你信任这个网络。

```bash
HOST=0.0.0.0 PORT=4317 node src/server.js
```

在另一台设备打开：

```
http://<服务器的局域网 IP>:4317
```

查看 IP：

```bash
# Linux
ip addr | grep 'inet '
# macOS
ipconfig getifaddr en0
```

> ⚠️ 局域网模式没有 E2EE，也没有密码。只建议在可信网络里短时间使用。长期用请选 A 或 B。

---

## 3.5 在服务器上直接用 TUI

不想开浏览器时，SSH 到 daemon 机器后：

```bash
cd ~/lite-code
node src/tui.js
```

连另一台机器：

```bash
node src/tui.js --ws ws://127.0.0.1:4317/ws
```

走 relay + E2EE：

```bash
node src/tui.js --offer "$(RELAY_URL=wss://lite.agentx1.com node src/pair.js | grep https)"
```

按键：

```
Enter 发送 · Tab 切换线程 · n 新线程 · p 新项目 · ↑/↓ 或 j/k 滚动
d 看 diff · y/n 批准/拒绝 · 1-9 选择 · Esc 取消/清空 · q 退出
```

TUI 需要 TTY，适合 SSH 场景；手机还是用浏览器/PWA。

`p` 新建项目时支持 `~`、相对路径、Tab 补全目录，以及实时校验（`git ✓` / `目录不存在`）。路径补全基于运行 TUI 的机器；如果 TUI 不在 daemon 机器上（例如用 `--offer` 从笔记本连），请直接输入服务器上的绝对路径。

## 4. 让 daemon 常驻（systemd）

不要把 token 写进 unit 文件，放到一个 600 权限的环境文件：

```bash
sudo install -m 600 /dev/null /etc/t3lite.env
sudo tee /etc/t3lite.env >/dev/null <<'EOF'
RELAY_URL=wss://lite.agentx1.com
RELAY_TOKEN=replace-me
T3LITE_SERVER_ID=my-linux-box
HOST=127.0.0.1
PORT=4317
T3LITE_HOME=/home/you/.t3lite
EOF
```

`/etc/systemd/system/t3lite.service`：

```ini
[Unit]
Description=T3 Lite
After=network-online.target
Wants=network-online.target

[Service]
User=you
WorkingDirectory=/home/you/lite-code
EnvironmentFile=/etc/t3lite.env
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now t3lite
journalctl -u t3lite -f
```

> systemd 的 `PATH` 可能找不到 `pi`。如果日志报 `spawn pi ENOENT`，在环境文件里加：
> `PI_BIN=/home/you/.local/bin/pi`（用 `which pi` 查真实路径）。

---

## 5. 更新与维护

### 更新代码

```bash
cd ~/lite-code
git pull
npm install
sudo systemctl restart t3lite
```

### 备份

需要备份的只有：

```
~/.t3lite/t3lite.sqlite      # 项目/线程/事件
~/.t3lite/daemon-key.json    # 配对身份（丢了所有设备要重配）
~/.t3lite/worktrees/         # 可选，正在改的 worktree
```

### 换 relay token

```bash
npx wrangler secret put RELAY_TOKEN
# 然后更新 /etc/t3lite.env 里的 RELAY_TOKEN
sudo systemctl restart t3lite
```

### 撤销所有配对设备

删除 daemon 密钥并重启：

```bash
rm ~/.t3lite/daemon-key.json
sudo systemctl restart t3lite
# 旧配对链接全部失效，重新 node src/pair.js
```

### 配对链接过期

默认 24 小时。重新生成即可：

```bash
RELAY_URL=wss://lite.agentx1.com node src/pair.js
```

想要更长/更短：

```bash
T3LITE_PAIR_TTL_MS=604800000 RELAY_URL=... node src/pair.js   # 7 天
```

---

## 6. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `https://域名/health` 404 | Worker 没部署 / 自定义域名没生效 | `npx wrangler deploy`；检查 DNS 和证书 |
| daemon 日志 `relay disconnected` 后重连 | 网络抖动 / Worker 重启 | 等自动重连；检查 `RELAY_TOKEN` |
| 手机打开链接一直“连接中” | daemon 没连上 relay | 在服务器 `journalctl -u t3lite -f` 看 `relay connected` |
| `503 daemon offline` | relay 在线但 daemon 不在 | 启动 daemon；确认 `T3LITE_SERVER_ID` 一致 |
| `401 unauthorized` | `RELAY_TOKEN` 不匹配 | Worker secret 和 daemon env 改成同一个值 |
| `配对失败：daemon proof failed` | 链接由旧 daemon key 生成 | 重新 `node src/pair.js`；必要时删 `daemon-key.json` |
| 页面能开但没有线程 | 连的是另一个 server / 空库 | 确认 `T3LITE_SERVER_ID` 和 `T3LITE_HOME` |
| `spawn pi ENOENT` | systemd 的 PATH 找不到 pi | 设 `PI_BIN=$(which pi)` |
| `No API key found` | Pi 没登录 | 用运行 daemon 的用户执行 `pi /login` |
| 手机 E2EE 报 `crypto.subtle` 不存在 | 页面不是 HTTPS / localhost | 用 `https://` 的 relay，或用 Tailscale/局域网本地模式 |
| `git worktree failed` | 目录不是 git 仓库 / 分支冲突 | 项目路径指向 git 仓库；检查 `~/.t3lite/worktrees` |

### 快速自检

在服务器：

```bash
curl http://127.0.0.1:4317/api/health
curl https://lite.agentx1.com/health
journalctl -u t3lite -n 50 --no-pager
```

在手机/另一台电脑：

```bash
curl https://lite.agentx1.com/health
```

都 200，再看 daemon 日志里有没有 `relay connected` 和 `pair`。

---

## 7. 安全模型（重要）

- **配对链接 = 密码**。谁拿到链接，谁就能连 daemon（和 Paseo 一样）。不要发到公开群。
- **E2EE**：客户端与 daemon 做 X25519 ECDH，HKDF 派生 AES-256-GCM key；Cloudflare 只转发密文，无法读取或篡改。
- **relay token** 只保护“哪台 daemon 可以注册”，不保护用户内容。
- **Cloudflare 托管前端 JS**：它理论上可以替换 JS 读取 fragment 里的公钥并伪装客户端。E2EE 防的是网络/relay 读取，不是恶意前端。原生 App 才能完全避开这个信任问题。
- **本地/Tailscale/局域网模式没有 E2EE**，只有传输层保护（本机回环 / WireGuard / 可信 Wi-Fi）。
- 不要把 `HOST=0.0.0.0` 直接暴露到公网；当前没有登录密码。
- 定期轮换 `RELAY_TOKEN`；怀疑链接泄漏就删 `daemon-key.json` 并重新配对。

---

## 8. 一页命令速查

服务器：

```bash
cd ~/lite-code
RELAY_URL=wss://lite.agentx1.com \
RELAY_TOKEN='...' \
T3LITE_SERVER_ID=my-linux-box \
node src/server.js

# 另一个终端
RELAY_URL=wss://lite.agentx1.com node src/pair.js
```

手机/电脑：

```
打开 https://lite.agentx1.com/#offer=...
```

本机检查：

```bash
curl http://127.0.0.1:4317/api/health
curl https://lite.agentx1.com/health
```

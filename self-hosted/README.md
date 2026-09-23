# 在自有 VPS 运行完整办办AI网站

如果目前只需要通过服务器 IP 使用，先阅读 [独立 IP 部署](IP-DEPLOY.md)：不要求修改域名 Nginx、证书或重新安装现有检测服务。本页仅供日后将 `ai.banban.plus` 正式指向网站时使用。

`ai.banban.plus` 的 DNS 保持指向 VPS。Nginx 把首页、静态资源和 `/v1/*` 交给本机 Next.js 网站（127.0.0.1:3000）。网站把检测任务交给本机检测进程（127.0.0.1:8787）。检测进程调用用户输入的模型接口 `/models` 与 `/responses`，不依赖参考网站或外部网页托管。用户 API Key 不存进 SQLite，已完成结果和截图保存 7 天。

先检查服务器现有仓库路径与 systemd 单元。下面 `/opt/banban-ai` 只是示例；若现有项目在 `/wwwroot/ai`，将服务文件中的 `WorkingDirectory`、`ExecStart` 和缓存目录都改成实际路径，再拉取更新。不要覆盖同机其他网站。

## 环境准备

- Linux，Node.js 24+；系统已有 Nginx 和 `ai.banban.plus` HTTPS 证书。
- 从项目根目录运行 `corepack pnpm install --frozen-lockfile` 与 `npm run build:vps`。不要运行根目录的 `npm run build`，该命令构建的是旧托管版。
- 构建后确保 `banban` 用户可以读项目文件、写 `/opt/banban-ai/.next` 运行缓存（例如将 `.next` 的所有者设为 `banban:banban`）。
- 检测服务在 `detector-server/`，依照该目录的说明安装 Chromium：`cd detector-server && npm ci && npm test`，由 `banban` 用户安装 Playwright Chromium。保持检测服务 `HOST=127.0.0.1`、`PORT=8787`。
- 创建用户 `banban` 和目录 `/var/lib/banban-web`、`/var/lib/banban-detector`，将目录所有者设为 `banban:banban`，权限 `700`。

## 服务环境

使用 `openssl rand -hex 32` **生成一次**密钥，保存在本机 `/etc/banban-detector.env` 和 `/etc/banban-web.env`，文件权限 `600`，不要提交到仓库或发给别人。两个服务的密钥必须相同。

```text
# /etc/banban-detector.env
SERVICE_TOKEN=同一个随机密钥
DATA_DIR=/var/lib/banban-detector
HOST=127.0.0.1
PORT=8787

# /etc/banban-web.env
BANBAN_SELF_HOSTED=1
BANBAN_TEST_SERVICE_TOKEN=同一个随机密钥
BANBAN_WEB_DATA_DIR=/var/lib/banban-web
NODE_ENV=production
```

从 `detector-server/deploy/banban-detector.service.example` 和 `self-hosted/deploy/banban-web.service.example` 安装两个 systemd 单元；根据 `command -v node` 核对服务内 Node 路径。`systemctl daemon-reload` 后启用并启动两个服务。

对照 [Nginx 配置](deploy/nginx.conf.example)修改现有 **ai.banban.plus** 的 HTTPS server 块；沿用现有证书路径，保留其他网站。`/health` 可指向 8787，所有 `/v1/*` 和 `/` 必须指向网站 3000。不要把 8787 直接开放到公网，也不要将首页代理到其他站点。运行 `nginx -t` 后 reload。

## 验收

```bash
curl -i http://127.0.0.1:3000/
curl -i http://127.0.0.1:8787/health
curl -i -X POST http://127.0.0.1:3000/v1/models -H 'Content-Type: application/json' -d '{}'
curl -i -X POST http://127.0.0.1:3000/v1/tests -H 'Content-Type: application/json' -d '{}'
curl -i https://ai.banban.plus/
```

首页应返回包含“办办AI”的 HTML；健康检查为 200；两个不完整请求应返回中文校验错误，不能是 404/401/Cloudflare 403。实际使用时在网页填入自己的模型接口、API Key，读取 GPT 模型，分别提交糖果测试和鹈鹕骑行，等待结束并核对鹈鹕截图、后台切换与历史记录。服务重启可能中断尚在运行的任务；已经完成的结果可查询。不同浏览器历史记录仍是各浏览器单独保存。

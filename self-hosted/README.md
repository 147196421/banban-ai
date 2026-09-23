# 在自有 VPS 运行完整办办AI网站

如果目前只需要通过服务器 IP 使用，先阅读 [独立 IP 部署](IP-DEPLOY.md)：不要求修改域名 Nginx、证书或重新安装现有检测服务。本页仅供日后将 `ai.banban.plus` 正式指向网站时使用。

`ai.banban.plus` 的 DNS 保持指向 VPS。Nginx 把首页、静态资源和 `/v1/*` 交给本机 Next.js 网站（127.0.0.1:3000）。新任务默认由网站服务器调用满血 AI 的公开检测接口；读取模型仍使用用户填写的模型 API。用户 API Key 不存进 SQLite，已完成报告保存 7 天，满血 AI 上的任务有自己的保留期限。详见 [检测接口说明](REFERENCE-DETECTOR.md)。

先检查服务器现有仓库路径与 systemd 单元。下面 `/opt/banban-ai` 只是示例；若现有项目在 `/wwwroot/ai`，将服务文件中的 `WorkingDirectory`、`ExecStart` 和缓存目录都改成实际路径，再拉取更新。不要覆盖同机其他网站。

## 环境准备

- Linux，Node.js 24+；系统已有 Nginx 和 `ai.banban.plus` HTTPS 证书。
- 从项目根目录运行 `corepack pnpm install --frozen-lockfile` 与 `npm run build:vps`。不要运行根目录的 `npm run build`，该命令构建的是旧托管版。
- 构建后确保 `banban` 用户可以读项目文件、写 `/opt/banban-ai/.next` 运行缓存（例如将 `.next` 的所有者设为 `banban:banban`）。
- 原有检测服务在 `detector-server/`，旧任务查询、旧截图或手动恢复本机结构检查时需保持运行；新任务无需重新安装 Chromium。
- 创建用户 `banban` 和目录 `/var/lib/banban-web`、`/var/lib/banban-detector`，将目录所有者设为 `banban:banban`，权限 `700`。

## 服务环境

已有本机检测服务时，沿用现有密钥，不要提交到仓库或发给别人。两个服务的密钥必须相同。

```text
# /etc/banban-detector.env
SERVICE_TOKEN=同一个随机密钥
DATA_DIR=/var/lib/banban-detector
HOST=127.0.0.1
PORT=8787

# /etc/banban-web.env
BANBAN_SELF_HOSTED=1
BANBAN_EVALUATION_MODE=manxue
BANBAN_TEST_SERVICE_TOKEN=同一个随机密钥
BANBAN_WEB_DATA_DIR=/var/lib/banban-web
NODE_ENV=production
```

从 `self-hosted/deploy/banban-web.service.example` 安装网站 systemd 单元；已有本机检测服务可保留供旧任务使用。根据 `command -v node` 核对服务内 Node 路径。更新时只重启网站服务。

已有 **ai.banban.plus** 的 HTTPS Nginx 配置保持不变；所有 `/v1/*` 和 `/` 必须指向网站 3000。不要把 8787 直接开放到公网，也不要将首页代理到其他站点。

## 验收

```bash
curl -i http://127.0.0.1:3000/
curl -i http://127.0.0.1:8787/health
curl -i -X POST http://127.0.0.1:3000/v1/models -H 'Content-Type: application/json' -d '{}'
curl -i -X POST http://127.0.0.1:3000/v1/tests -H 'Content-Type: application/json' -d '{}'
curl -i https://ai.banban.plus/
```

首页应返回包含“办办AI”的 HTML；若保留原检测服务，健康检查为 200；两个不完整请求应返回中文校验错误，不能是 404/401/Cloudflare 403。实际使用时在网页填入自己的模型接口、API Key，读取 GPT 模型，分别提交糖果测试和鹈鹕骑行，等待结束并核对判定、作品预览、后台切换与历史记录。服务重启可能中断尚在运行的任务；已经完成的结果可查询。不同浏览器历史记录仍是各浏览器单独保存。

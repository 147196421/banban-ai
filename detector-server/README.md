# 办办AI 独立检测服务

把本目录部署到自己的 Linux 服务器。服务运行糖果题和鹈鹕 HTML 动画任务，任务编号、结果和浏览器截图保留 7 天；API Key 只用于本次模型调用，不写入数据库和日志。浏览器关闭后，服务器进程仍会继续执行。服务器重启时尚未完成的任务会显示“中断”，用户可重新提交。

这是一套**独立编写**的固定糖果题与鹈鹕结构规则，不是满血AI的后端源码。糖果题只将明确作答 21 的结果判为通过；鹈鹕结果中保存真实 Chromium 截图和 HTML，截图失败时会显示提示并保留 HTML 预览。结构判定仅检查代码中的动画、车轮与鹈鹕元素，不能单凭一次测试证明模型身份或视觉质量。

## 环境

- Linux、Node.js 24 或更新、可连接目标 GPT API。
- Chromium：先安装系统依赖，再**以运行服务的同一用户**下载浏览器。若服务器已有可运行的 Chrome/Chromium，可设置 `CHROME_PATH=/usr/bin/chromium`。
- 自建网站与检测服务部署在同一台 VPS 时，`ai.banban.plus` 的 Nginx 将网站请求转给 3000，网站内部连接 8787。公网**不要直接开放 8787**。完整步骤见 [VPS 部署说明](../self-hosted/README.md)。
- 独立生成一个不少于 32 位的 `SERVICE_TOKEN`；网站和服务必须使用同一值，且不得提交到 GitHub。

## 安装与启动

```bash
git clone https://github.com/147196421/banban-ai.git /opt/banban-ai
cd /opt/banban-ai/detector-server
npm ci
sudo npx playwright install-deps chromium
sudo useradd --system --create-home --shell /usr/sbin/nologin banban
sudo install -d -o banban -g banban -m 700 /var/lib/banban-detector
sudo -u banban -H ./node_modules/.bin/playwright install chromium
sudo -u banban -H env SERVICE_TOKEN="$(openssl rand -hex 32)" DATA_DIR=/var/lib/banban-detector node server.mjs
```

上面最后一行仅用于临时试运行：正式部署应把随机密钥存入 `/etc/banban-detector.env`（`chmod 600`），并由 systemd 加载；重启时**沿用同一密钥**。进程以非 root 用户运行、`DATA_DIR` 对该用户可写。可参照 [systemd 服务示例](deploy/banban-detector.service.example)和 [Nginx 示例](deploy/nginx.conf.example)；若 Node 不在 `/usr/bin/node`，请先用 `command -v node` 修改服务文件路径。推荐先在服务器运行 `npm test`，再运行服务。

环境变量：

| 名称 | 用途 |
| --- | --- |
| `SERVICE_TOKEN` | 网站到检测服务的共享密钥，必填，至少 32 字符 |
| `DATA_DIR` | SQLite 数据库与 PNG 截图目录；默认当前目录 `data` |
| `PORT` | 本地 HTTP 端口，默认 `8787` |
| `HOST` | 默认 `127.0.0.1`，只接受本机反代 |
| `CHROME_PATH` | 可选，系统 Chromium 的可执行路径 |

先确认 `curl http://127.0.0.1:8787/health` 返回 `{"status":"ok"}`。访问 `https://ai.banban.plus/` 应显示办办AI网站，并保持地址栏域名不变。检测服务提供 `POST /v1/tests`、`GET /v1/tests/:id` 与 `GET /v1/tests/:id/screenshot`，均需要请求头 `X-Banban-Service-Token`；网站的同名 `/v1/*` 路由会代用户发起任务，不把共享密钥交给浏览器。

## 接入办办AI 网站

在网站进程的 `/etc/banban-web.env` 中设置：

```text
BANBAN_TEST_SERVICE_TOKEN=与服务器 SERVICE_TOKEN 相同的密钥
BANBAN_SELF_HOSTED=1
```

自建模式固定使用本机 `http://127.0.0.1:8787/v1/tests`，无须单独的检测域名。`ai.banban.plus` 的 DNS 继续指向 VPS。网站 `/v1/models` 仍只读取用户填写的模型接口；历史记录保留在用户浏览器中。不要在公开页面、仓库或截图里显示共享密钥。

## 运行限制

- 支持 OpenAI 兼容的 `/v1/responses` 请求；有些中转接口只支持 `/chat/completions`，此版会提示接口不兼容。
- 服务同时执行最多 2 个模型任务，内存中最多排队 10 个；任务运行超过约 7 分钟会报超时。
- 输入密钥不保存，服务器重启会中断尚未完成的任务。已完成的结果和截图保留 7 天。
- 测试题与评分规则属于办办AI自行编写，不能保证与其他网站给出相同结论。

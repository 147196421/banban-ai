# IP 独立部署：先访问 http://<服务器IP>:3080/

本方式只在服务器新增一个办办AI网站进程，保留既有域名站点、Nginx、检测服务和证书。网站端口 3080；新任务默认使用满血 AI 公开接口，旧任务仍可查询本机端口 8787。不要运行系统更新、重启服务器或安装 Chromium 系统依赖。

`http://<服务器IP>:3080/` 只用于验证页面和不含真实密钥的接口。完整测试会向网站发送用户 API Key，正式使用时必须先通过受信任的 HTTPS 访问。可在服务器资源稳定后单独为 IP 配置受信任的证书与自动续期，或用现有 HTTPS 域名；不要在普通 HTTP 页面填写真实 API Key。

1. 只读检查 `free -h`、`df -h`、`uptime`、`ss -ltnp`、`systemctl status`，记录此前关机原因（如 `journalctl -k -b -1` 中的 OOM）。确认项目实际路径、Node.js 版本（24+）、8787 检测服务健康、服务密钥现存位置。内存不足或发生过 OOM 时先报告，不要再次在该服务器上构建。
2. 在现有仓库执行 `git pull --ff-only`。如果 3080 已被占用，先报告冲突，不要杀进程。项目根目录仅执行 `corepack pnpm install --frozen-lockfile` 和 `npm run build:vps`。不要启动 `npm run build`（旧托管版）。安装或构建失败时报告日志，不要重装系统或修改其他服务。
3. 给新网站单独设置可写的任务目录和环境变量：`BANBAN_WEB_DATA_DIR` 指向可写目录，`BANBAN_SELF_HOSTED=1`。旧任务仍需原有 `BANBAN_TEST_SERVICE_TOKEN` 与检测服务的 `SERVICE_TOKEN` 相同。新任务默认使用满血 AI 接口，无需新增该站令牌；不要将用户 API Key 写入环境文件或仓库。
4. 从项目目录执行 `npm run start:ip`，监听 `0.0.0.0:3080`。先检查 `curl -i http://127.0.0.1:3080/` 返回办办AI HTML，以及 `/v1/models`、`/v1/tests` 的校验请求能返回中文 JSON；再用手机访问 `http://<服务器IP>:3080/`。只有本机可访问时，检查云厂商安全组与主机防火墙是否允许 TCP 3080。**只新增 3080 的放行规则**，不得关闭防火墙或改变现有端口。
5. 若要不带端口访问 `http://<服务器IP>/`，先确认该 IP 对应的 Nginx 80 端口未被其他业务使用，再参考 [独立 IP 配置](deploy/nginx-ip.conf.example)新增对应 IP 的 server 块，保持其他 server 块原样；`nginx -t` 成功才 reload。已有 IP 站点时不要覆盖，先报告冲突。

确认 3080 服务稳定后，参考 [独立 systemd 服务](deploy/banban-web-ip.service.example)只为网站添加一个新服务，以便长期运行；按实际仓库路径修改示例中的 `/opt/banban-ai`，并确保运行用户可写任务目录与 `.next` 缓存。不要停止或替换现有检测服务。`/#history` 是网页的定位锚点；浏览器历史由该地址的 localStorage 单独保存，外部站点的旧历史不会自动迁入这个 IP 地址。

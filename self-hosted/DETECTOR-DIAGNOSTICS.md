# 检测任务创建失败排查

任务创建错误现在会在页面和历史记录中保留检测服务 HTTP 状态及诊断编号；服务器同时输出一条 `[detector-create-failed]` JSON 日志，使用同一编号关联。此变更用于定位故障，不代表已修复上游拒绝请求的原因。

日志包含检测来源、阶段对应错误类别、HTTP 状态、响应格式及脱敏后的错误消息。参数校验错误支持 `detail` 数组里的 `msg`，仅记录已知参数名称，不记录 `input` 或 `ctx`。请求正文、完整上游响应、响应头和 Cookie 不写日志；已知凭据和接口地址在截断前脱敏。HTML 只记录格式，非 JSON 文本只提取数字错误码。

## 部署和复测

1. 按 `self-hosted/README.md` 在已有 VPS 项目目录部署本次提交，运行 `npm run build:vps`，成功后只重启网站服务。此改动不需要数据库迁移，不需要重启检测服务或修改密钥。
2. 在网站使用原来的配置提交一次鹈鹕测试，记下页面诊断编号。不要重复提交一批任务。
3. 若网站使用仓库示例中的 `banban-web` systemd 单元，在服务器执行：

   ```bash
   journalctl -u banban-web --since '10 minutes ago' --no-pager | grep -F '[detector-create-failed]'
   ```

   若实际服务名称不同，请使用原有名称。只需对应诊断编号的日志，不需要发送环境文件、完整服务日志或 API Key。

4. 根据证据处理：400/422 检查参数及上游协议；401/403 检查检测服务访问权限或限制，不能直接判定模型 API Key 失效；3xx 检查服务地址，不自动带着凭据跟随跳转；2xx 格式异常核对返回结构；网络和超时错误检查服务器到检测服务的连接。

本地回归：`node --test tests/detector-diagnostics.test.mjs tests/model-stream.test.mjs`。这些测试使用模拟响应，不访问第三方或消耗模型额度。

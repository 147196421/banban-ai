# 使用满血 AI 的公开检测接口

办办 AI 的“自定义生成”独立于糖果和鹈鹕固定检测。用户输入提示词时，网站服务器直接向所填模型接口的 `/responses` 发送提示词，异步保存模型输出，再将完整 HTML 放入隔离的浏览器预览；普通文字则显示文本。自定义生成不提交给满血 AI，也不显示满血 AI 的质量评分。API Key 仅随这次请求使用，不存入任务记录。

满血 AI 的 [API 文档](https://manxue.ai/api) 公开 `POST https://manxue.ai/api/v1/tests` 和 `GET https://manxue.ai/api/v1/tests/{id}`，无需该站令牌。网站服务端提交用户填写的模型 API 地址和 Key，检测服务调用模型并返回糖果结果或鹈鹕判定。此地址与用户填写的模型 API 地址不同；检测依赖满血 AI 的可用性，模型调用仍消耗用户 Key 的额度。用户 Key 不写进本地数据库或浏览器缓存，但会随单次检测请求发送给满血 AI。

VPS 构建默认使用该公开接口；若现有服务器曾设置 `BANBAN_EVALUATION_MODE=reference` 或 `self-hosted`，部署时将其改为 `BANBAN_EVALUATION_MODE=manxue`。网站自己的 `/v1/tests` 保留任务索引与历史记录，浏览器切到后台后可继续查询。满血 AI 的任务最多运行 10 分钟、保留 1 小时；办办 AI 会保存已完成的结果。满血任务返回鹈鹕 HTML 后，网站调用本机 8787 的独立截图接口用 Chromium 渲染并保存 PNG，不会再调用模型或修改满血判定。需保留原 `BANBAN_TEST_SERVICE_TOKEN` 和本机检测服务；该服务不可用时只显示作品预览。

历史任务会使用创建时的检测服务查询。旧的本机检测结果仍标为结构检查，不会被改写为满血 AI 的判定。等正在执行的旧任务完成后更新更稳妥。满血 AI 当前不开放浏览器跨域调用，必须由网站服务器发起请求。服务不可达时显示检测失败，不会静默改成本机的简易规则。

如需恢复原本的本机结构检查，在网站进程设置 `BANBAN_EVALUATION_MODE=self-hosted`，保留原有 `BANBAN_SELF_HOSTED=1` 和 `BANBAN_TEST_SERVICE_TOKEN`。若已持有旧托管站真实检测地址，也可设置 `BANBAN_EVALUATION_MODE=reference` 与 `BANBAN_TEST_SERVICE_URL`；目前无法仅凭该私有配置断言它等于满血 AI 的地址。

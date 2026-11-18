# 使用满血 AI 的公开检测接口

办办 AI 的“自定义生成”独立于糖果和鹈鹕固定检测。用户输入提示词时，网站服务器直接向所填模型接口的 `/responses` 发送提示词，异步保存模型输出，再将完整 HTML 放入隔离的浏览器预览；普通文字则显示文本。自定义生成不提交给满血 AI，也不显示满血 AI 的质量评分。API Key 仅随这次请求使用，不存入任务记录。

满血 AI 的 [API 文档](https://manxue.ai/api) 公开 `POST https://manxue.ai/api/v1/tests` 和 `GET https://manxue.ai/api/v1/tests/{id}`，无需该站令牌。网站服务端提交用户填写的模型 API 地址和 Key，检测服务调用模型并返回糖果结果或鹈鹕判定。此地址与用户填写的模型 API 地址不同；检测依赖满血 AI 的可用性，模型调用仍消耗用户 Key 的额度。用户 Key 不写进本地数据库或浏览器缓存，但会随单次检测请求发送给满血 AI。

当前版本：新客户端显式选择流式或同步时走访客 `/api/visitor/tests`，由网站服务器建立访客会话，携带 `stream` 和 `protocol: "responses"` 提交；旧客户端未传请求类型时仍走公开 `/api/v1/tests`。鹈鹕使用 `benchmark: "pelican"`，勾选自由创作在访客接口提交 `random_scene: true`。鹈鹕和自由创作可填写接口支持的任意 GPT 模型，推理程度支持 low、medium、high；非 `gpt-6-astra` 的作品判定仅供参考。公开接口仍可使用 `benchmark: "creative"`，不接受访客接口的 `protocol`、`random_scene` 字段。“自定义生成”独立支持 Responses / Chat Completions。

糖果检测推理程度支持 low、medium、high、xhigh、max、ultra，实际支持情况取决于所选模型和接口。这里的 ultra 是推理程度；UltraFast 是独立的快速模式。

网站自己的 `/v1/tests` 保留任务索引与历史记录，浏览器切到后台后可继续查询。满血 AI 的任务最多运行 10 分钟、保留 1 小时；办办 AI 会保存已完成的结果。满血任务返回鹈鹕 HTML 后，网站调用本机 8787 的独立截图接口用 Chromium 渲染并保存 PNG，不会再调用模型或修改满血判定。需保留原 `BANBAN_TEST_SERVICE_TOKEN` 和本机检测服务；该服务不可用时只显示作品预览。

历史任务会使用创建时的检测服务查询。旧的本机检测结果仍标为结构检查，不会被改写为满血 AI 的判定。等正在执行的旧任务完成后更新更稳妥。满血 AI 当前不开放浏览器跨域调用，必须由网站服务器发起请求。服务不可达时显示检测失败，不会静默改成本机的简易规则。

如需恢复原本的本机结构检查，在网站进程设置 `BANBAN_EVALUATION_MODE=self-hosted`，保留原有 `BANBAN_SELF_HOSTED=1` 和 `BANBAN_TEST_SERVICE_TOKEN`。若已持有旧托管站真实检测地址，也可设置 `BANBAN_EVALUATION_MODE=reference` 与 `BANBAN_TEST_SERVICE_URL`；目前无法仅凭该私有配置断言它等于满血 AI 的地址。

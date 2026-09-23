// 办办AI 自建检测服务。共享密钥仅由网站服务器发送，浏览器不会接触它。
const ownTestsUrl = "https://ai.banban.plus/v1/tests";

export function getDetectorService() {
  const token = process.env.BANBAN_TEST_SERVICE_TOKEN?.trim();
  if (token) {
    if (token.length < 32) return null;
    return { url: ownTestsUrl, headers: { "X-Banban-Service-Token": token } };
  }

  // 旧版上线期间保持现有任务可查询；配置自建服务密钥后即自动切换。
  const previousUrl = process.env.BANBAN_TEST_SERVICE_URL?.trim().replace(/\/+$/, "");
  if (!previousUrl?.startsWith("https://")) return null;
  return { url: previousUrl, headers: {} };
}

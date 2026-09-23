// 检测任务由网站服务器转发，浏览器不会直接接触检测服务或附带的 API Key。
const manxueTestsUrl = "https://manxue.ai/api/v1/tests";
const ownTestsUrl = "https://detector.banban.plus/v1/tests";

export type DetectorSource = "manxue" | "reference" | "self-hosted";

export function getDetectorService(source?: DetectorSource) {
  const previousUrl = process.env.BANBAN_TEST_SERVICE_URL?.trim().replace(/\/+$/, "");
  const selected = source ?? (
    process.env.BANBAN_EVALUATION_MODE === "self-hosted" ? "self-hosted"
      : process.env.BANBAN_EVALUATION_MODE === "reference" ? "reference"
        : process.env.BANBAN_SELF_HOSTED !== "1" && previousUrl ? "reference" : "manxue"
  );

  if (selected === "manxue") {
    return { url: manxueTestsUrl, headers: {} as Record<string, string>, source: selected };
  }
  if (selected === "reference") {
    if (!previousUrl?.startsWith("https://")) return null;
    return { url: previousUrl, headers: {} as Record<string, string>, source: selected };
  }

  const token = process.env.BANBAN_TEST_SERVICE_TOKEN?.trim();
  if (!token || token.length < 32) return null;
  const localUrl = process.env.BANBAN_SELF_HOSTED === "1"
    ? "http://127.0.0.1:8787/v1/tests"
    : ownTestsUrl;
  return { url: localUrl, headers: { "X-Banban-Service-Token": token }, source: selected };
}

// 在任务索引中保留创建时使用的服务，切换配置后仍能查询旧任务和截图。
export function storedDetectorTask(source: DetectorSource, id: string) {
  return `${source}:${id}`;
}

export function readStoredDetectorTask(storedId: string | null | undefined) {
  const match = /^(manxue|reference|self-hosted):(.+)$/.exec(storedId ?? "");
  if (match) return { source: match[1] as DetectorSource, id: match[2] };
  return {
    source: process.env.BANBAN_SELF_HOSTED === "1" ? "self-hosted" as const : "reference" as const,
    id: storedId ?? "",
  };
}

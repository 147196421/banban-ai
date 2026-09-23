import { getDetectorService } from "@/lib/detector-service";

// 满血负责判定，本机浏览器仅渲染它已经返回的 HTML，不再请求模型。
export async function attachLocalScreenshot(report: Record<string, unknown>, taskId: string) {
  if (report.evaluation_source !== "manxue" || report.benchmark !== "pelican" || report.status !== "succeeded") {
    return report;
  }
  const result = report.result && typeof report.result === "object"
    ? report.result as Record<string, unknown> : null;
  if (!result || typeof result.html !== "string" || !result.html.trim() || result.screenshot_url) return report;

  const local = getDetectorService("self-hosted");
  const screenshotError = "浏览器截图暂时不可用，已显示作品预览";
  if (local) {
    try {
      const response = await fetch(`${local.url.replace(/\/v1\/tests$/, "")}/v1/screenshots`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", ...local.headers },
        body: JSON.stringify({ id: taskId, html: result.html }),
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
      const payload = await response.json().catch(() => ({})) as { screenshot_url?: unknown };
      if (response.ok && payload.screenshot_url === `/v1/screenshots/${taskId}`) {
        return {
          ...report,
          result: {
            ...result,
            screenshot_url: `/v1/tests/${taskId}/screenshot`,
            screenshot_source: "self-hosted",
          },
        };
      }
    } catch {
      // 截图失败不能覆盖满血已经返回的质量结论。
    }
  }
  return { ...report, result: { ...result, screenshot_error: screenshotError } };
}

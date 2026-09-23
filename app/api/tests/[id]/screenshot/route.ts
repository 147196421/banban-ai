import { finishStoredTask, getStoredTask } from "@/db/test-tasks";
import { getDetectorService, readStoredDetectorTask } from "@/lib/detector-service";
import { attachLocalScreenshot } from "@/lib/report-screenshot";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return new Response(null, { status: 404 });
  try {
    const stored = await getStoredTask(id);
    const payload = stored?.payload_json ? JSON.parse(stored.payload_json) as Record<string, unknown> : null;
    let result = payload?.result && typeof payload.result === "object" ? payload.result as Record<string, unknown> : null;
    if (!stored?.upstream_task_id || !result || stored.status !== "succeeded") {
      return new Response(null, { status: 404 });
    }
    if (!result.screenshot_url && typeof result.html === "string" && result.html.trim() && payload) {
      const updated = await attachLocalScreenshot(payload, id);
      result = updated.result && typeof updated.result === "object" ? updated.result as Record<string, unknown> : result;
      if (result.screenshot_url) await finishStoredTask(id, "succeeded", updated);
    }
    if (!result.screenshot_url) return new Response(null, { status: 503 });
    const upstream = readStoredDetectorTask(stored.upstream_task_id);
    const localScreenshot = result.screenshot_source === "self-hosted";
    const service = getDetectorService(localScreenshot ? "self-hosted" : upstream.source);
    if (!service) return new Response(null, { status: 503 });
    const imageUrl = localScreenshot
      ? `${service.url.replace(/\/v1\/tests$/, "")}/v1/screenshots/${encodeURIComponent(id)}`
      : `${service.url}/${encodeURIComponent(upstream.id)}/screenshot`;
    const image = await fetch(imageUrl, {
      headers: {
        Accept: "image/png",
        ...service.headers,
        ...(upstream.visitorCookie && !localScreenshot ? { Cookie: `gallery_visitor=${upstream.visitorCookie}` } : {}),
      },
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const size = Number(image.headers.get("content-length") || 0);
    if (!image.ok || !image.headers.get("content-type")?.startsWith("image/png") || size > 2_000_000) return new Response(null, { status: 502 });
    const bytes = await image.arrayBuffer();
    if (bytes.byteLength > 2_000_000) return new Response(null, { status: 502 });
    return new Response(bytes, { headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" } });
  } catch {
    return new Response(null, { status: 502 });
  }
}

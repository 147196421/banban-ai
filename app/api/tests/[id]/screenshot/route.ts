import { getStoredTask } from "@/db/test-tasks";
import { getDetectorService, readStoredDetectorTask } from "@/lib/detector-service";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return new Response(null, { status: 404 });
  try {
    const stored = await getStoredTask(id);
    const payload = stored?.payload_json ? JSON.parse(stored.payload_json) as Record<string, unknown> : null;
    const result = payload?.result && typeof payload.result === "object" ? payload.result as Record<string, unknown> : null;
    if (!stored?.upstream_task_id || !result?.screenshot_url || stored.status !== "succeeded") {
      return new Response(null, { status: 404 });
    }
    const upstream = readStoredDetectorTask(stored.upstream_task_id);
    const service = getDetectorService(upstream.source);
    if (!service) return new Response(null, { status: 503 });
    const image = await fetch(`${service.url}/${encodeURIComponent(upstream.id)}/screenshot`, {
      headers: {
        Accept: "image/png",
        ...service.headers,
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

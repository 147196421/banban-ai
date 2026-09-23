import { getStoredTask } from "@/db/test-tasks";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: "任务编号无效" }, { status: 400 });
  try {
    const task = await getStoredTask(id);
    if (!task) return Response.json({ error: "生成任务不存在或已过期" }, { status: 404 });
    if (task.payload_json) return Response.json(JSON.parse(task.payload_json));
    if (task.status === "failed") return Response.json({ id, status: "failed", error: task.error });
    if (task.status === "creating" && Date.now() - task.created_at > 8 * 60 * 1000)
      return Response.json({ id, status: "failed", error: "生成超时，请重试" });
    return Response.json({ id, status: "running", phase: "generating" });
  } catch {
    return Response.json({ error: "暂时无法查询生成结果" }, { status: 503 });
  }
}

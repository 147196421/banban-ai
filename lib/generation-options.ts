const frontendReasoningEfforts = ["low", "medium", "high"] as const;
const allReasoningEfforts = [...frontendReasoningEfforts, "xhigh", "max", "ultra"] as const;
export type ReasoningEffort = typeof allReasoningEfforts[number];
type ReasoningMode = "reasoning" | "frontend" | "custom";
export type RequestType = "stream" | "sync";

export function allowedReasoningEfforts(mode: ReasoningMode): readonly ReasoningEffort[] {
  return mode === "frontend" ? frontendReasoningEfforts : allReasoningEfforts;
}

export function parseReasoningEffort(value: unknown, mode: ReasoningMode = "custom", fallback: ReasoningEffort = "low"): ReasoningEffort {
  if (value === undefined) return fallback;
  if (typeof value === "string" && allowedReasoningEfforts(mode).includes(value as ReasoningEffort)) return value as ReasoningEffort;
  throw new Error(mode === "frontend" ? "鹈鹕骑行和自由创作仅支持 low、medium、high 推理程度" : "推理程度无效，请重新选择");
}

export function parseRequestType(value: unknown): RequestType {
  if (value === undefined || value === "stream") return "stream";
  if (value === "sync") return "sync";
  throw new Error("请求类型无效，请选择流式或同步");
}

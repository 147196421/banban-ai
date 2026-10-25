export const reasoningEfforts = ["low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = typeof reasoningEfforts[number];
export type RequestType = "stream" | "sync";

export function allowedReasoningEfforts(frontend: boolean): readonly ReasoningEffort[] {
  // The public pelican/creative API only accepts these three levels.
  return frontend ? reasoningEfforts.slice(0, 3) : reasoningEfforts;
}

export function parseReasoningEffort(value: unknown, frontend = false, fallback: ReasoningEffort = "low"): ReasoningEffort {
  if (value === undefined) return fallback;
  if (typeof value === "string" && allowedReasoningEfforts(frontend).includes(value as ReasoningEffort)) return value as ReasoningEffort;
  throw new Error(frontend ? "鹈鹕骑行和自由创作仅支持 low、medium、high 推理程度" : "推理程度无效，请重新选择");
}

export function parseRequestType(value: unknown): RequestType {
  if (value === undefined || value === "stream") return "stream";
  if (value === "sync") return "sync";
  throw new Error("请求类型无效，请选择流式或同步");
}

export type ServiceTier = "default" | "priority" | "ultrafast";

export const serviceTierLabels: Record<ServiceTier, string> = {
  default: "默认",
  priority: "Fast",
  ultrafast: "UltraFast",
};

// Manxue's default means omitting the upstream field, not sending "default".
export function parseServiceTier(value: unknown): Exclude<ServiceTier, "default"> | undefined {
  if (value === undefined || value === "default") return undefined;
  if (value === "priority" || value === "ultrafast") return value;
  throw new Error("快速模式无效，请选择默认、Fast 或 UltraFast");
}

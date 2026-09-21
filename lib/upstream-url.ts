const blockedIpv4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^224\./,
  /^25[0-5]\./,
];

function isBlockedHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "::1" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("fe80:")
  ) {
    return true;
  }

  if (blockedIpv4.some((pattern) => pattern.test(host))) return true;

  const parts = host.split(".").map(Number);
  if (parts.length === 4 && parts.every(Number.isFinite)) {
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
  }

  return false;
}

export function normalizeUpstreamBaseUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 2048) {
    throw new Error("接口地址无效");
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("请输入完整的 HTTPS 接口地址");
  }

  if (url.protocol !== "https:" || url.username || url.password || isBlockedHost(url.hostname)) {
    throw new Error("仅支持公开可访问的 HTTPS 接口地址");
  }

  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function isGptModel(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 160) return false;
  const id = value.trim().toLowerCase();
  if (!(id.startsWith("gpt-") || id.includes("/gpt-"))) return false;
  return !/(audio|realtime|transcri|tts|image|embedding|moderation)/.test(id);
}


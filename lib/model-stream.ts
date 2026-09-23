type Protocol = "responses" | "chat_completions";

type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
};

type StreamResult = { text: string; usage?: Usage };

export async function readModelStream(response: Response, protocol: Protocol): Promise<StreamResult> {
  if (!response.body) throw new Error("模型没有返回内容");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let usage: Usage | undefined;
  let completed = false;
  let truncated = false;

  const onEvent = (block: string) => {
    const lines = block.split("\n");
    const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
    const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) return;
    if (data === "[DONE]") {
      completed = true;
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(data) as Record<string, unknown>;
    } catch {
      throw new Error("模型返回了无效内容，请重试");
    }

    const kind = String(payload.type ?? event ?? "");
    if (kind === "error" || kind === "response.failed") throw new Error("服务器暂时无法完成生成，请稍后重试");
    if (kind === "response.incomplete") truncated = true;
    if (kind === "response.output_text.delta" && typeof payload.delta === "string") text += payload.delta;
    if (kind === "response.completed") {
      completed = true;
      const final = payload.response as Record<string, unknown> | undefined;
      if (!text && final) text = outputText(final, "responses");
      usage = final?.usage as Usage | undefined;
    }
    if (protocol === "chat_completions" && Array.isArray(payload.choices)) {
      for (const item of payload.choices) {
        const choice = item as { delta?: { content?: string | { text?: string }[] }; finish_reason?: string };
        const content = choice.delta?.content;
        if (typeof content === "string") text += content;
        else if (Array.isArray(content)) text += content.map((part) => part.text ?? "").join("");
        if (choice.finish_reason === "length") truncated = true;
        if (choice.finish_reason === "stop") completed = true;
        if (choice.finish_reason && !["stop", "length"].includes(choice.finish_reason)) {
          throw new Error("模型未能完成生成，请重新生成");
        }
      }
    }
    if (payload.usage && typeof payload.usage === "object") usage = payload.usage as Usage;
    if (text.length > 500_000) throw new Error("生成内容过长，请缩短提示词");
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer = (buffer + decoder.decode(value, { stream: !done })).replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        onEvent(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
      if (buffer.length > 1_000_000) throw new Error("模型返回的内容过长，请缩短提示词");
      if (done) break;
    }
    if (buffer.trim()) onEvent(buffer);
    if (truncated) throw new Error("输出达到长度上限，请缩短提示词或重新生成");
    if (!completed) throw new Error("模型连接中断，请重新生成");
    if (!text.trim()) throw new Error("模型没有返回内容");
    return { text, usage };
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function outputText(payload: Record<string, unknown>, protocol: Protocol) {
  if (protocol === "chat_completions") {
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const message = (choices[0] as { message?: { content?: unknown } } | undefined)?.message;
    if (typeof message?.content === "string") return message.content;
    if (Array.isArray(message?.content)) {
      return message.content.map((part: { text?: unknown }) => typeof part?.text === "string" ? part.text : "").join("");
    }
    return "";
  }
  if (typeof payload.output_text === "string") return payload.output_text;
  const output = Array.isArray(payload.output) ? payload.output : [];
  return output.flatMap((item) => {
    const message = item as { content?: { type?: string; text?: string }[] };
    return Array.isArray(message.content)
      ? message.content.filter((part) => part.type === "output_text").map((part) => part.text ?? "")
      : [];
  }).join("\n");
}

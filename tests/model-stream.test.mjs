import assert from 'node:assert/strict';
import test from 'node:test';

import { readModelStream } from '../lib/model-stream.ts';

function streamResponse(parts) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}

test('Responses events reconstruct HTML across split SSE frames', async () => {
  const response = streamResponse([
    'event: response.output_text.delta\r\n',
    'data: {"type":"response.output_text.delta","delta":"<html>你"}\r',
    '\n\r\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"好</html>"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":4,"output_tokens":9}}}\n\n',
  ]);
  assert.deepEqual(await readModelStream(response, 'responses'), {
    text: '<html>你好</html>', usage: { input_tokens: 4, output_tokens: 9 },
  });
});

test('Chat completion consumes deltas and rejects a cut off connection', async () => {
  const good = streamResponse([
    'data: {"choices":[{"delta":{"content":"<svg>"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"</svg>"},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  assert.equal((await readModelStream(good, 'chat_completions')).text, '<svg></svg>');

  const interrupted = streamResponse(['data: {"choices":[{"delta":{"content":"<svg>"}}]}\n\n']);
  await assert.rejects(readModelStream(interrupted, 'chat_completions'), /连接中断/);
});

test('Length limit is not shown as a completed work', async () => {
  const response = streamResponse([
    'data: {"choices":[{"delta":{"content":"<svg>"},"finish_reason":"length"}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  await assert.rejects(readModelStream(response, 'chat_completions'), /长度上限/);
});

import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

// Exercise the real route, URL validation, retry helper and model filtering.
// Only the database-backed rate limiter and external HTTP transport are mocked.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@/db/rate-limit') {
      return { url: 'data:text/javascript,export async function checkRateLimit(){return {allowed:true}}', shortCircuit: true };
    }
    if (specifier.startsWith('@/')) {
      return nextResolve(new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href, context);
    }
    return nextResolve(specifier, context);
  },
});
const { POST } = await import('../app/api/models/route.ts');
hooks.deregister();

const request = () => new Request('https://site.example/v1/models', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ baseUrl: 'https://api.example.com/v1', apiKey: 'test-route-secret' }),
});

test('route recovers a failed connection and returns normalized GPT models', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    if (++calls === 1) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    return Response.json({ data: [null, { id: ' gpt-6-astra ' }, { id: 'gpt-6-astra' }, { id: 'gpt-image-1' }, 'gpt-6.1-sol'] });
  });
  const response = await POST(request());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { models: ['gpt-6-astra', 'gpt-6.1-sol'] });
  assert.equal(calls, 2);
});

test('route returns 502 for exhausted network errors with credential-free diagnostics', async (t) => {
  let calls = 0;
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args));
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    throw new TypeError('test-route-secret', { cause: { code: 'ECONNREFUSED' } });
  });
  const response = await POST(request());
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /服务器暂时无法连接模型接口.*已自动重试/);
  assert.equal(calls, 2);
  assert.equal(logs.length, 1);
  assert.ok(!JSON.stringify(logs).includes('test-route-secret'));
  assert.match(JSON.stringify(logs), /ECONNREFUSED/);
});

test('route preserves authentication errors without retries', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json({ error: { message: 'invalid api key' } }, { status: 401 });
  });
  const response = await POST(request());
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /API Key 无效/);
  assert.equal(calls, 1);
});

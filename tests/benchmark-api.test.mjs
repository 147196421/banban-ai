import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

// Use the actual creation/poll routes and service selection; isolate only Next's
// lifecycle and the database. All upstream requests are captured by test mocks.
const fixtureUrl = `data:text/javascript,${encodeURIComponent(`
  export const tasks = new Map();
  export const pending = [];
  export function after(fn) { pending.push(fn); }
  export async function checkRateLimit() { return { allowed: true }; }
  export async function getStoredTask(id) { return tasks.get(id); }
  export async function createStoredTask(id) {
    const inserted = !tasks.has(id);
    if (inserted) tasks.set(id, { id, status: 'creating', created_at: Date.now() });
    return { inserted, task: tasks.get(id) };
  }
  export async function markStoredTaskActive(id, upstream_task_id) { Object.assign(tasks.get(id), { status: 'active', upstream_task_id }); }
  export async function markStoredTaskFailed(id, error) { Object.assign(tasks.get(id), { status: 'failed', error }); }
  export async function finishStoredTask(id, status, payload) { Object.assign(tasks.get(id), { status, payload_json: JSON.stringify(payload) }); }
  export async function removeExpiredTasks() {}
`)}`;
const fixture = await import(fixtureUrl);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (['next/server', '@/db/test-tasks', '@/db/rate-limit'].includes(specifier)) return { url: fixtureUrl, shortCircuit: true };
    if (specifier.startsWith('@/')) return nextResolve(new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href, context);
    return nextResolve(specifier, context);
  },
});
const { POST } = await import('../app/api/tests/route.ts');
const { GET } = await import('../app/api/tests/[id]/route.ts');
const { POST: generate } = await import('../app/api/generations/route.ts');
const { toChineseError } = await import('../lib/user-facing-error.ts');
hooks.deregister();

const id = 'f67ed6bf-8df2-4055-95c2-9636fa403174';
const request = (overrides = {}) => new Request('https://site.example/v1/tests', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ submissionId: id, benchmark: 'frontend', baseUrl: 'https://api.example.com/v1', apiKey: 'test-only-key', model: 'gpt-6-astra', ...overrides }),
});
const flush = async () => { while (fixture.pending.length) await fixture.pending.shift()(); };
test.beforeEach(() => { fixture.tasks.clear(); fixture.pending.length = 0; });

test('pelican excludes removed fields even when an old client sends them, then polls and persists the result', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init });
    return init.method === 'POST'
      ? Response.json({ id: 'upstream-pelican', status: 'running' }, { status: 202 })
      : Response.json({ id: 'upstream-pelican', benchmark: 'pelican', status: 'succeeded', result: { html: '<svg>pelican</svg>' }, assessment: { quality: 'normal' } });
  });
  assert.equal((await POST(request({ protocol: 'chat_completions', random_scene: true }))).status, 202);
  await flush();
  assert.equal(calls[0].url, 'https://manxue.ai/api/v1/tests');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    benchmark: 'pelican', base_url: 'https://api.example.com/v1', api_key: 'test-only-key', model: 'gpt-6-astra', reasoning_effort: 'low',
  });
  assert.equal(calls[0].init.headers['Idempotency-Key'], id);
  const response = await GET(new Request(`https://site.example/v1/tests/${id}`), { params: Promise.resolve({ id }) });
  const report = await response.json();
  assert.equal(calls[1].url, 'https://manxue.ai/api/v1/tests/upstream-pelican');
  assert.equal(report.id, id);
  assert.equal(report.status, 'succeeded');
  assert.equal(report.evaluation_source, 'manxue');
  assert.equal(report.assessment.quality, 'normal');
  assert.equal(fixture.tasks.get(id).status, 'succeeded');
});

test('free creation uses the public creative benchmark without a visitor session', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init });
    return Response.json({ id: 'creative-task' }, { status: 202 });
  });
  assert.equal((await POST(request({ freeCreation: true }))).status, 202);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://manxue.ai/api/v1/tests');
  assert.equal(JSON.parse(calls[0].init.body).benchmark, 'creative');
  for (const field of ['protocol', 'random_scene', 'public']) assert.ok(!(field in JSON.parse(calls[0].init.body)));
  assert.equal(calls[0].init.headers.Cookie, undefined);
  assert.equal(fixture.tasks.get(id).upstream_task_id, 'manxue:creative-task');
});

test('unsupported pelican models are rejected before creating or sending a task', async () => {
  for (const freeCreation of [false, true]) {
    const response = await POST(request({ model: 'gpt-6.1-sol', freeCreation }));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /仅支持 gpt-6-astra/);
  }
  assert.equal(fixture.tasks.size, 0);
  assert.equal(fixture.pending.length, 0);
});

test('candy keeps its existing model and effort without removed API fields', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.deepEqual(JSON.parse(init.body), {
      benchmark: 'candy', base_url: 'https://api.example.com/v1', api_key: 'test-only-key', model: 'gpt-6.1-sol', reasoning_effort: 'medium',
    });
    return Response.json({ id: 'candy-task' }, { status: 202 });
  });
  assert.equal((await POST(request({ benchmark: 'reasoning', model: 'gpt-6.1-sol' }))).status, 202);
  await flush();
});

test('duplicate local submissions do not create another upstream task', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ id: 'one-task' }, { status: 202 }); });
  await POST(request());
  await flush();
  assert.equal((await POST(request())).status, 200);
  await flush();
  assert.equal(calls, 1);
});

test('historical visitor tasks still use their original endpoint and cookie', async (t) => {
  fixture.tasks.set(id, { id, status: 'active', upstream_task_id: 'manxue-visitor:old-task:old-cookie' });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://manxue.ai/api/visitor/tests/old-task');
    assert.equal(init.headers.Cookie, 'gallery_visitor=old-cookie');
    return Response.json({ id: 'old-task', status: 'running' });
  });
  const response = await GET(new Request(`https://site.example/v1/tests/${id}`), { params: Promise.resolve({ id }) });
  assert.equal((await response.json()).evaluation_source, 'manxue');
});

for (const [benchmark, freeCreation] of [['reasoning', false], ['frontend', false], ['frontend', true]]) {
  for (const serviceTier of ['default', 'priority', 'ultrafast']) {
    test(`${benchmark} free=${freeCreation} forwards selected tier ${serviceTier}`, async (t) => {
      let payload;
      t.mock.method(globalThis, 'fetch', async (_url, init) => {
        payload = JSON.parse(init.body);
        return Response.json({ id: 'tier-task' }, { status: 202 });
      });
      assert.equal((await POST(request({ benchmark, freeCreation, serviceTier }))).status, 202);
      await flush();
      assert.equal(payload.service_tier, serviceTier === 'default' ? undefined : serviceTier);
      assert.equal(Object.hasOwn(payload, 'service_tier'), serviceTier !== 'default');
      assert.equal(payload.reasoning_effort, benchmark === 'reasoning' ? 'medium' : 'low');
      assert.equal(fixture.tasks.get(id).status, 'active');
    });
  }
}

for (const protocol of ['responses', 'chat_completions']) {
  for (const serviceTier of [undefined, 'default', 'priority', 'ultrafast']) {
    test(`custom ${protocol} forwards ${serviceTier ?? 'omitted'} tier and saves output`, async (t) => {
      let payload;
      t.mock.method(globalThis, 'fetch', async (url, init) => {
        assert.equal(url, `https://api.example.com/v1/${protocol === 'responses' ? 'responses' : 'chat/completions'}`);
        payload = JSON.parse(init.body);
        return Response.json(protocol === 'responses'
          ? { status: 'completed', output_text: '<html><body>OK</body></html>' }
          : { choices: [{ finish_reason: 'stop', message: { content: '<html><body>OK</body></html>' } }] });
      });
      assert.equal((await generate(request({ protocol, serviceTier, prompt: 'Make a small HTML page' }))).status, 202);
      await flush();
      assert.equal(payload.service_tier, ['priority', 'ultrafast'].includes(serviceTier) ? serviceTier : undefined);
      assert.equal(Object.hasOwn(payload, 'service_tier'), ['priority', 'ultrafast'].includes(serviceTier));
      assert.equal(protocol === 'responses' ? payload.reasoning.effort : payload.reasoning_effort, 'low');
      assert.equal(fixture.tasks.get(id).status, 'succeeded');
      assert.match(JSON.parse(fixture.tasks.get(id).payload_json).result.html, /OK/);
    });
  }
}

test('invalid tiers are rejected before any task is created', async () => {
  for (const handler of [POST, generate]) {
    for (const serviceTier of ['fast', 'auto', null, 1, {}]) {
      const response = await handler(request({ serviceTier, prompt: 'test' }));
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /快速模式无效/);
    }
  }
  assert.equal(fixture.tasks.size, 0);
  assert.equal(fixture.pending.length, 0);
});

test('unsupported tiers have a specific error without silently falling back', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { message: "Unsupported value: service_tier ultrafast" } }, { status: 400 }));
  await generate(request({ serviceTier: 'ultrafast', prompt: 'test' }));
  await flush();
  assert.equal(fixture.tasks.get(id).status, 'failed');
  assert.match(fixture.tasks.get(id).error, /快速模式.*默认/);
  assert.match(toChineseError({ message: 'Unsupported value: service_tier priority' }), /快速模式/);
});

for (const requestType of ['stream', 'sync']) {
  for (const [benchmark, freeCreation, reasoningEffort] of [['reasoning', false, 'max'], ['frontend', false, 'medium'], ['frontend', true, 'high']]) {
    test(`visitor ${benchmark} creative=${freeCreation} ${requestType} is private and polls with its own cookie`, async (t) => {
      const calls = [];
      t.mock.method(globalThis, 'fetch', async (url, init) => {
        calls.push({ url, init });
        if (url.endsWith('/config')) return Response.json({}, { headers: { 'Set-Cookie': 'gallery_visitor=test-cookie; Path=/; HttpOnly; Secure' } });
        assert.equal(init.headers.Cookie, 'gallery_visitor=test-cookie');
        if (init.method === 'POST') {
          assert.equal(url, 'https://manxue.ai/api/visitor/tests');
          assert.deepEqual(JSON.parse(init.body), {
            benchmark: benchmark === 'reasoning' ? 'candy' : 'pelican',
            base_url: 'https://api.example.com/v1', api_key: 'test-only-key', model: 'gpt-6-astra',
            reasoning_effort: reasoningEffort, public: false, protocol: 'responses', preserve_base_url: true,
            stream: requestType === 'stream', service_tier: 'priority', ...(freeCreation ? { random_scene: true } : {}),
          });
          assert.equal(init.headers['Idempotency-Key'], id);
          return Response.json({ id: 'visitor-task', status: 'running' }, { status: 202 });
        }
        assert.equal(url, 'https://manxue.ai/api/visitor/tests/visitor-task');
        return Response.json({ id: 'visitor-task', status: 'succeeded', public: false, result: { html: '<html>OK</html>' } });
      });
      const response = await POST(request({ benchmark, freeCreation, reasoningEffort, requestType, serviceTier: 'priority' }));
      assert.equal(response.status, 202);
      assert.ok(!(await response.text()).includes('test-cookie'));
      await flush();
      assert.equal(fixture.tasks.get(id).upstream_task_id, 'manxue-visitor:visitor-task:test-cookie');
      const result = await GET(new Request(`https://site.example/v1/tests/${id}`), { params: Promise.resolve({ id }) });
      const report = await result.json();
      assert.equal(report.status, 'succeeded');
      assert.equal(report.public, false);
      assert.equal(calls.length, 3);
      assert.ok(!JSON.stringify(report).includes('test-cookie'));
    });
  }
}

for (const reasoningEffort of ['low', 'medium', 'high', 'xhigh', 'max']) {
  for (const protocol of ['responses', 'chat_completions']) {
    for (const requestType of ['stream', 'sync']) {
      test(`custom ${protocol} ${reasoningEffort} ${requestType} transmits options and consumes the response`, async (t) => {
        t.mock.method(globalThis, 'fetch', async (_url, init) => {
          const body = JSON.parse(init.body);
          assert.equal(body.stream, requestType === 'stream');
          assert.equal(protocol === 'responses' ? body.reasoning.effort : body.reasoning_effort, reasoningEffort);
          const html = '<html><body>OK</body></html>';
          if (requestType === 'sync') return Response.json(protocol === 'responses'
            ? { status: 'completed', output_text: html, usage: { input_tokens: 11, output_tokens: 12 } }
            : { choices: [{ finish_reason: 'stop', message: { content: html } }], usage: { prompt_tokens: 11, completion_tokens: 12 } });
          const data = protocol === 'responses'
            ? { type: 'response.completed', response: { output_text: html, usage: { input_tokens: 11, output_tokens: 12 } } }
            : { choices: [{ delta: { content: html }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 12 } };
          return new Response(`data: ${JSON.stringify(data)}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
        });
        assert.equal((await generate(request({ protocol, reasoningEffort, requestType, prompt: 'test' }))).status, 202);
        await flush();
        assert.equal(fixture.tasks.get(id).status, 'succeeded');
        const result = JSON.parse(fixture.tasks.get(id).payload_json).result;
        assert.match(result.html, /OK/);
        assert.equal(result.input_tokens, 11);
        assert.equal(result.output_tokens, 12);
      });
    }
  }
}

test('invalid reasoning and request types never create tasks or contact upstream', async () => {
  for (const handler of [POST, generate]) {
    for (const requestType of [null, false, 'false', 'streaming', {}]) {
      const response = await handler(request({ requestType, prompt: 'test' }));
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /请求类型无效/);
    }
    for (const reasoningEffort of [null, 1, 'ultra', 'none', {}]) {
      const response = await handler(request({ benchmark: 'reasoning', reasoningEffort, prompt: 'test' }));
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /推理程度无效/);
    }
  }
  for (const reasoningEffort of ['xhigh', 'max']) {
    assert.equal((await POST(request({ reasoningEffort, requestType: 'sync' }))).status, 400);
  }
  assert.equal(fixture.tasks.size, 0);
  assert.equal(fixture.pending.length, 0);
});

test('failed visitor session does not submit any model credentials', async (t) => {
  let calls = 0;
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls++;
    assert.equal(url, 'https://manxue.ai/api/visitor/config');
    assert.equal(init.body, undefined);
    return Response.json({}, { status: 503 });
  });
  await POST(request({ requestType: 'sync' }));
  await flush();
  assert.equal(calls, 1);
  assert.equal(fixture.tasks.get(id).status, 'failed');
});

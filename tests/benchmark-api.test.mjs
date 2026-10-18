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

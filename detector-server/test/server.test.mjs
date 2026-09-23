import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createDetectorServer, normalizeBaseUrl } from '../server.mjs';
import { assessPelican, extractHtml, extractOutputText, judgeCandy } from '../engine.mjs';

const temp = await mkdtemp(join(tmpdir(), 'banban-detector-'));
const token = randomBytes(32).toString('hex');
const pelicanHtml = '<!doctype html><html><body><svg><circle/><circle/><text>pelican beak</text></svg><style>@keyframes spin{to{transform:rotate(360deg)}}</style></body></html>';
let finishCandy;
const gate = new Promise((resolve) => { finishCandy = resolve; });
const calls = [];
const app = await createDetectorServer({
  token,
  dataDir: temp,
  verifyTarget: async () => {},
  screenshot: async (_html, id, directory) => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(directory, 'screenshots'), { recursive: true });
    const path = join(directory, 'screenshots', `${id}.png`);
    await writeFile(path, Buffer.from('fake-png'));
    return path;
  },
  fetchProvider: async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    if (body.model === 'gpt-5.5') return new Response(JSON.stringify({ error: { message: 'upstream unavailable' } }), { status: 503 });
    if (body.input.includes('红、蓝、绿')) await gate;
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: body.input.includes('红、蓝、绿') ? '21' : pelicanHtml }] }], usage: { input_tokens: 10, output_tokens: 20 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  },
});
app.server.listen(0, '127.0.0.1');
await new Promise((resolve) => app.server.once('listening', resolve));
const origin = `http://127.0.0.1:${app.server.address().port}`;
after(async () => {
  await new Promise((resolve) => app.server.close(resolve));
  app.close();
  await rm(temp, { recursive: true, force: true });
});

async function api(path, options = {}) {
  return fetch(`${origin}${path}`, { ...options, headers: { 'x-banban-service-token': token, ...options.headers } });
}

async function finished(id) {
  for (let i = 0; i < 100; i += 1) {
    const report = await (await api(`/v1/tests/${id}`)).json();
    if (['succeeded', 'failed'].includes(report.status)) return report;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('测试任务未按时完成');
}

test('任务立即返回，浏览器断开后仍在服务端完成，密钥不落盘', async () => {
  const secret = 'sk-test-secret-not-persisted';
  const denied = await fetch(`${origin}/v1/tests`);
  assert.equal(denied.status, 401);
  const response = await api('/v1/tests', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ benchmark: 'candy', base_url: 'https://api.example.com/v1', api_key: secret, model: 'gpt-6-astra', reasoning_effort: 'high' }),
  });
  assert.equal(response.status, 202);
  const created = await response.json();
  assert.match(created.id, /^[a-f0-9-]{36}$/);
  const running = await (await api(`/v1/tests/${created.id}`)).json();
  assert.equal(running.status, 'running');
  finishCandy();
  const report = await finished(created.id);
  assert.equal(report.status, 'succeeded');
  assert.equal(report.candy.status, 'passed');
  assert.equal(report.candy.input_tokens, 10);
  assert.equal(calls[0].reasoning.effort, 'high');
  assert.equal((await readFile(join(temp, 'tasks.sqlite'))).includes(Buffer.from(secret)), false);
  assert.equal(JSON.stringify(report).includes(secret), false);
});

test('鹈鹕任务保存 HTML 和实际截图，截图接口需要授权', async () => {
  const response = await api('/v1/tests', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ benchmark: 'pelican', base_url: 'https://api.example.com/v1', api_key: 'sk-test-only', model: 'gpt-6-astra', reasoning_effort: 'high' }),
  });
  assert.equal(response.status, 202);
  const { id } = await response.json();
  const report = await finished(id);
  assert.equal(report.status, 'succeeded');
  assert.equal(report.assessment.quality, 'normal');
  assert.equal(report.result.html, pelicanHtml);
  assert.equal(report.result.screenshot_url, `/v1/tests/${id}/screenshot`);
  assert.equal((await api(`/v1/tests/${id}/screenshot`)).status, 200);
  assert.equal((await fetch(`${origin}/v1/tests/${id}/screenshot`)).status, 401);
});

test('拒绝内网地址，判定函数不会把包含 121 的回答判为 21', async () => {
  await assert.rejects(normalizeBaseUrl('https://127.0.0.1/v1', async () => {}));
  assert.equal(judgeCandy('121'), 'incorrect');
  assert.equal(judgeCandy('答案：21'), 'passed');
  assert.equal(extractHtml(`\`\`\`html\n${pelicanHtml}\n\`\`\``), pelicanHtml);
  assert.equal(assessPelican('').quality, 'degraded');
  assert.equal(extractOutputText({ output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: '21' }] }] }), '21');
});

test('上游模型 5xx 被记录为中文失败结果，不暴露原始英文报错', async () => {
  const response = await api('/v1/tests', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ benchmark: 'pelican', base_url: 'https://api.example.com/v1', api_key: 'sk-invalid-probe', model: 'gpt-5.5', reasoning_effort: 'high' }),
  });
  const { id } = await response.json();
  const report = await finished(id);
  assert.equal(report.status, 'failed');
  assert.equal(report.error, '模型接口暂时不可用');
});

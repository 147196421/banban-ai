import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectDetectorResponse, detectorTransportFailure, redactDetectorMessage } from '../lib/detector-diagnostics.ts';

const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
});

test('successful creation preserves the task ID without returning credentials', async () => {
  assert.deepEqual(await inspectDetectorResponse(jsonResponse({ id: 'task-123', api_key: 'secret' }), ['secret']), {
    id: 'task-123', failure: null,
  });
  assert.equal((await inspectDetectorResponse(jsonResponse({ id: 123 }), [])).id, '123');
});

test('422 validation details retain messages and allowlisted fields, never input or ctx', async () => {
  const result = await inspectDetectorResponse(jsonResponse({ detail: [{
    loc: ['body', 'protocol'], msg: 'Input should be responses',
    input: 'arbitrary-secret', ctx: { api_key: 'another-secret' },
  }] }, 422), []);
  assert.equal(result.failure.diagnostic.status, 422);
  assert.deepEqual(result.failure.diagnostic.validationFields, ['protocol']);
  assert.equal(result.failure.diagnostic.message, 'Input should be responses');
  assert.match(result.failure.userMessage, /提交参数.*422/);
  assert.doesNotMatch(JSON.stringify(result), /arbitrary-secret|another-secret/);
});

test('403 text error retains an error code without blaming the model API key', async () => {
  const result = await inspectDetectorResponse(new Response('error code: 1010\nsecret-body', { status: 403 }), []);
  assert.equal(result.failure.diagnostic.message, 'error code: 1010');
  assert.match(result.failure.userMessage, /检测服务拒绝访问.*403/);
  assert.doesNotMatch(JSON.stringify(result), /secret-body|API Key 无效/);
});

test('HTML and redirect destinations are never logged', async () => {
  const result = await inspectDetectorResponse(new Response('<html>secret-body</html>', {
    status: 302, headers: { 'Content-Type': 'text/html', Location: 'https://example.com/?key=secret-url' },
  }), []);
  assert.equal(result.failure.diagnostic.category, 'redirect');
  assert.equal(result.failure.diagnostic.responseFormat, 'html');
  assert.doesNotMatch(JSON.stringify(result), /secret-body|secret-url/);
});

test('unknown JSON error survives sanitization in diagnostics, not in the public message', async () => {
  const secret = 'test-key/with"quotes-and spaces';
  const message = `Validation rejected: ${secret} ${encodeURIComponent(secret)} ${JSON.stringify(secret).slice(1, -1)} sk-other-credential Bearer another-token https://example.com/?token=private`;
  const result = await inspectDetectorResponse(jsonResponse({ error: { message } }, 400), [secret]);
  assert.match(result.failure.diagnostic.message, /Validation rejected/);
  for (const value of [secret, encodeURIComponent(secret), 'sk-other-credential', 'another-token', 'private']) {
    assert.ok(!JSON.stringify(result).includes(value));
  }
  assert.doesNotMatch(result.failure.userMessage, /Validation rejected/);
});

test('redaction occurs before truncation and removes log injection newlines', () => {
  const secret = 'x'.repeat(900);
  const result = redactDetectorMessage(`prefix\n${secret}\r\nsuffix`, [secret]);
  assert.equal(result, 'prefix [REDACTED]  suffix');
});

test('200 responses with missing IDs, invalid IDs, errors or non-JSON fail explicitly', async () => {
  for (const payload of [{ data: { id: 'nested' } }, { id: {} }, { id: 'task', error: 'rejected' }]) {
    const result = await inspectDetectorResponse(jsonResponse(payload), []);
    assert.equal(result.failure.diagnostic.category, payload.error ? 'upstream_error' : 'missing_task_id');
    assert.match(result.failure.userMessage, /返回格式异常.*200/);
  }
  const result = await inspectDetectorResponse(new Response('unexpected response'), []);
  assert.equal(result.failure.diagnostic.category, 'invalid_json');
});

test('transport failures are sanitized and timeouts are distinguished', () => {
  const result = detectorTransportFailure(new TypeError('fetch failed: private-key'), ['private-key']);
  assert.equal(result.diagnostic.category, 'transport_error');
  assert.equal(result.diagnostic.message, 'fetch failed: [REDACTED]');
  assert.equal(detectorTransportFailure(new DOMException('timed out', 'TimeoutError'), []).diagnostic.category, 'timeout');
});

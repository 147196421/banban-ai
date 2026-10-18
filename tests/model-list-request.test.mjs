import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelListConnectionError, requestModelList } from '../lib/model-list-request.ts';

const baseUrl = 'https://api.example.com/v1';
const key = 'test-secret-only';
const models = { data: [{ id: 'gpt-6-astra' }, { id: 'gpt-6.1-sol' }] };
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const connectionError = (code) => new TypeError('fetch failed with test-secret-only', { cause: { code } });

function transport(sequence) {
  const requests = [];
  const delays = [];
  return {
    requests, delays,
    fetch: async (url, init) => {
      requests.push({ url, init });
      assert.ok(sequence.length, 'unexpected extra retry');
      const next = sequence.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    sleep: async (ms) => { delays.push(ms); },
  };
}

test('successful model listing makes exactly one authenticated read-only request', async () => {
  const mock = transport([json(models)]);
  assert.deepEqual((await requestModelList(baseUrl, key, mock)).payload, models);
  assert.equal(mock.requests.length, 1);
  assert.equal(mock.requests[0].url, `${baseUrl}/models`);
  assert.equal(mock.requests[0].init.method, 'GET');
  assert.equal(mock.requests[0].init.headers.Authorization, `Bearer ${key}`);
  assert.equal(mock.requests[0].init.redirect, 'manual');
  assert.deepEqual(mock.delays, []);
});

test('a temporary refused connection recovers with one retry', async () => {
  const mock = transport([connectionError('ECONNREFUSED'), json(models)]);
  assert.deepEqual((await requestModelList(baseUrl, key, mock)).payload, models);
  assert.equal(mock.requests.length, 2);
  assert.deepEqual(mock.delays, [500]);
});

test('temporary gateway errors, empty lists and invalid JSON recover', async () => {
  for (const response of [new Response('<html>Bad gateway</html>', { status: 502 }), json({}, 503), json({ data: [] }), new Response('broken JSON')]) {
    const mock = transport([response, json(models)]);
    assert.deepEqual((await requestModelList(baseUrl, key, mock)).payload, models);
    assert.equal(mock.requests.length, 2);
  }
});

test('body socket failure after receiving headers is retried', async () => {
  const broken = new Response(new ReadableStream({ start(controller) { controller.error(connectionError('UND_ERR_SOCKET')); } }));
  const mock = transport([broken, json(models)]);
  assert.deepEqual((await requestModelList(baseUrl, key, mock)).payload, models);
  assert.equal(mock.requests.length, 2);
});

test('authentication, validation, rate-limit and redirect responses are never retried', async () => {
  for (const status of [400, 401, 403, 404, 422, 429, 301, 302, 307, 308]) {
    const mock = transport([json({ error: 'denied' }, status)]);
    assert.equal((await requestModelList(baseUrl, key, mock)).status, status);
    assert.equal(mock.requests.length, 1);
    assert.deepEqual(mock.delays, []);
  }
});

test('an unreadable 401 body still does not retry authentication', async () => {
  const response = new Response(new ReadableStream({ start(controller) { controller.error(connectionError('ECONNRESET')); } }), { status: 401 });
  const mock = transport([response]);
  assert.equal((await requestModelList(baseUrl, key, mock)).status, 401);
  assert.equal(mock.requests.length, 1);
});

test('long Retry-After is respected instead of retrying immediately', async () => {
  const mock = transport([json({ error: 'busy' }, 503, { 'Retry-After': '60' })]);
  assert.equal((await requestModelList(baseUrl, key, mock)).status, 503);
  assert.equal(mock.requests.length, 1);
});

test('persistent network errors stop after two attempts and retain only a safe cause code', async () => {
  const mock = transport([connectionError('ECONNREFUSED'), connectionError('ECONNREFUSED')]);
  await assert.rejects(requestModelList(baseUrl, key, mock), (error) => {
    assert.ok(error instanceof ModelListConnectionError);
    assert.equal(error.status, 502);
    assert.equal(error.code, 'ECONNREFUSED');
    assert.equal(error.cause, undefined);
    assert.ok(!JSON.stringify(error).includes(key));
    assert.match(error.message, /已自动重试/);
    return true;
  });
  assert.equal(mock.requests.length, 2);
});

test('DNS and timeout failures retain distinct safe codes', async () => {
  for (const [error, status, code] of [
    [connectionError('ENOTFOUND'), 502, 'ENOTFOUND'],
    [connectionError('UND_ERR_CONNECT_TIMEOUT'), 504, 'UND_ERR_CONNECT_TIMEOUT'],
    [new DOMException('timed out', 'TimeoutError'), 504, 'TIMEOUT'],
  ]) {
    const mock = transport([error, error]);
    await assert.rejects(requestModelList(baseUrl, key, mock), (failure) => failure.status === status && failure.code === code);
  }
});

import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { assessPelican, callModel, extractHtml, judgeCandy, renderScreenshot } from './engine.mjs';

const oneWeek = 7 * 24 * 60 * 60 * 1000;
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}

function authenticated(req, token) {
  const given = req.headers['x-banban-service-token'];
  if (typeof given !== 'string' || !given) return false;
  const actual = Buffer.from(token);
  const supplied = Buffer.from(given);
  return actual.length === supplied.length && timingSafeEqual(actual, supplied);
}

function privateIp(ip) {
  if (ip.includes(':')) return ip === '::1' || ip.toLowerCase().startsWith('fc') || ip.toLowerCase().startsWith('fd') || ip.toLowerCase().startsWith('fe80:') || ip.startsWith('::ffff:');
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

export async function normalizeBaseUrl(input, verifyTarget) {
  if (typeof input !== 'string' || input.length > 2048) throw new Error('接口地址无效');
  let url;
  try { url = new URL(input.trim()); } catch { throw new Error('请输入完整的 HTTPS 接口地址'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !url.hostname.includes('.') || url.hostname.endsWith('.local')) {
    throw new Error('仅支持公开的 HTTPS 接口地址');
  }
  if (isIP(url.hostname) && privateIp(url.hostname)) throw new Error('不能使用内网接口地址');
  await verifyTarget(url.hostname);
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

async function publicHost(hostname) {
  const addresses = await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => privateIp(address))) throw new Error('接口地址不能指向内网');
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 12_000) throw new Error('请求内容过大');
  }
  try { return JSON.parse(raw); } catch { throw new Error('请求格式无效'); }
}

export async function createDetectorServer({
  token = process.env.SERVICE_TOKEN,
  dataDir = process.env.DATA_DIR || join(process.cwd(), 'data'),
  fetchProvider = fetch,
  screenshot = renderScreenshot,
  verifyTarget = publicHost,
} = {}) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('SERVICE_TOKEN 至少需要 32 位随机字符');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dataDir, 'tasks.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    UPDATE tasks SET status='failed', payload_json=json_set(payload_json,'$.status','failed','$.phase','complete','$.error','服务重启，检测已中断，请重新提交')
      WHERE status IN ('queued','running');`);
  const get = db.prepare('SELECT payload_json, status FROM tasks WHERE id=? AND expires_at>?');
  const insert = db.prepare('INSERT INTO tasks(id,status,payload_json,created_at,expires_at) VALUES(?,?,?,?,?)');
  const update = db.prepare('UPDATE tasks SET status=?,payload_json=? WHERE id=?');
  const pending = [];
  let active = 0;

  function save(id, payload) {
    update.run(payload.status, JSON.stringify(payload), id);
  }

  async function work(job) {
    const { id, input } = job;
    let report = JSON.parse(get.get(id, 0)?.payload_json || '{}');
    try {
      report = { ...report, status: 'running', phase: 'generating' };
      save(id, report);
      const generated = await callModel(input, fetchProvider);
      const measures = {
        duration_ms: generated.duration_ms,
        input_tokens: generated.input_tokens,
        output_tokens: generated.output_tokens,
      };
      if (input.benchmark === 'candy') {
        report.candy = { status: judgeCandy(generated.output), ...measures };
      } else {
        const html = extractHtml(generated.output);
        report.result = { html, has_html: Boolean(html), ...measures };
        report.assessment = assessPelican(html);
        if (html) {
          try {
            await screenshot(html, id, dataDir);
            report.result.screenshot_url = `/v1/tests/${id}/screenshot`;
          } catch {
            // 保留 HTML 预览，同时让网站明确提示截图未生成。
            report.result.screenshot_error = '浏览器截图生成失败，请检查服务器上的 Chromium';
          }
        }
      }
      report.status = 'succeeded';
      report.phase = 'complete';
      report.finished_at = new Date().toISOString();
      save(id, report);
    } catch (error) {
      report.status = 'failed';
      report.phase = 'complete';
      report.finished_at = new Date().toISOString();
      report.error = error instanceof Error && /[\u3400-\u9fff]/.test(error.message) ? error.message : '连接模型接口失败或超时，请稍后重试';
      save(id, report);
    } finally {
      // 密钥只存在于当前任务的内存对象中，从不写入数据库或日志。
      input.api_key = '';
      active -= 1;
      pump();
    }
  }

  function pump() {
    while (active < 2 && pending.length) {
      const job = pending.shift();
      active += 1;
      void work(job);
    }
  }

  async function cleanup() {
    const expired = db.prepare('SELECT id FROM tasks WHERE expires_at<?').all(Date.now());
    db.prepare('DELETE FROM tasks WHERE expires_at<?').run(Date.now());
    await Promise.all(expired.map(({ id }) => rm(join(dataDir, 'screenshots', `${id}.png`), { force: true }).catch(() => undefined)));
  }
  await cleanup();
  const cleanupTimer = setInterval(() => void cleanup(), 60 * 60 * 1000);
  cleanupTimer.unref();

  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    if (req.method === 'GET' && pathname === '/health') return send(res, 200, { status: 'ok' });
    if (!authenticated(req, token)) return send(res, 401, { error: '未授权' });

    if (req.method === 'POST' && pathname === '/v1/tests') {
      try {
        const body = await readJson(req);
        const benchmark = body.benchmark;
        if (!['candy', 'pelican'].includes(benchmark)) throw new Error('检测项目无效');
        const model = typeof body.model === 'string' ? body.model.trim() : '';
        if (!/(^|\/)gpt-/i.test(model) || model.length > 160) throw new Error('仅支持 GPT 文本模型');
        const key = typeof body.api_key === 'string' ? body.api_key.trim() : '';
        if (key.length < 6 || key.length > 4096) throw new Error('API Key 无效');
        const effort = body.reasoning_effort ?? 'high';
        const choices = benchmark === 'candy' ? ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] : ['low', 'medium', 'high'];
        if (!choices.includes(effort)) throw new Error('当前项目不支持该推理程度');
        const baseUrl = await normalizeBaseUrl(body.base_url, verifyTarget);
        if (pending.length >= 10) return send(res, 429, { error: '当前排队任务较多，请稍后再试' });
        const id = randomUUID();
        const now = Date.now();
        const payload = { id, benchmark, model, reasoning_effort: effort, status: 'queued', phase: 'creating', started_at: new Date(now).toISOString() };
        insert.run(id, 'queued', JSON.stringify(payload), now, now + oneWeek);
        pending.push({ id, input: { benchmark, model, reasoning_effort: effort, api_key: key, base_url: baseUrl } });
        pump();
        return send(res, 202, payload);
      } catch (error) {
        return send(res, 400, { error: error instanceof Error ? error.message : '请求无效' });
      }
    }

    const match = /^\/v1\/tests\/([a-z0-9-]+)(\/screenshot)?$/.exec(pathname);
    if (req.method === 'GET' && match && idPattern.test(match[1])) {
      const row = get.get(match[1], Date.now());
      if (!row) return send(res, 404, { error: '没有找到检测任务' });
      if (match[2]) {
        try {
          const image = await readFile(join(dataDir, 'screenshots', `${match[1]}.png`));
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' });
          return res.end(image);
        } catch { return send(res, 404, { error: '没有找到浏览器截图' }); }
      }
      return send(res, 200, JSON.parse(row.payload_json));
    }
    return send(res, 404, { error: '没有找到接口' });
  });

  return { server, db, close: () => { clearInterval(cleanupTimer); db.close(); } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { server } = await createDetectorServer();
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || '127.0.0.1';
  server.listen(port, host, () => process.stdout.write(`办办AI检测服务运行于 ${host}:${port}\n`));
}

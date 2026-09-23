import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const candyQuestion = '红、蓝、绿三盒糖一共有 60 颗。红盒比蓝盒多 4 颗，绿盒比蓝盒少 7 颗。蓝盒里有多少颗糖？只输出阿拉伯数字，不要解释。';
const pelicanQuestion = '请生成一份完整、可直接在浏览器运行的单文件 HTML：用 SVG/CSS/JavaScript 绘制鹈鹕骑自行车的动画。鹈鹕应有长喙、喉囊、翅膀与双脚；自行车应有两个车轮、车架、车把、脚踏。车轮与脚踏要持续运动，画面有背景。仅输出 HTML 原文，不要 Markdown 代码围栏，不引用外部资源。';

export function extractOutputText(payload) {
  if (typeof payload?.output_text === 'string') return payload.output_text;
  const parts = [];
  for (const item of payload?.output ?? []) {
    if (item?.type !== 'message') continue;
    for (const content of item.content ?? []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') parts.push(content.text);
    }
  }
  return parts.join('\n');
}

function providerError(payload, status) {
  const raw = typeof payload?.error === 'string' ? payload.error : payload?.error?.message;
  if (status === 401) return 'API Key 无效或已失效';
  if (status === 403) return '密钥没有该模型的权限';
  if (status === 404) return '接口没有这个模型或不支持 Responses API';
  if (status === 429) return '请求过于频繁或接口额度不足';
  if (status >= 500) return '模型接口暂时不可用';
  if (typeof raw === 'string' && /quota|balance|credit|billing/i.test(raw)) return '接口额度不足';
  if (typeof raw === 'string' && /reasoning|effort/i.test(raw)) return '模型不支持所选推理程度';
  return '模型调用失败，请检查接口配置';
}

export async function callModel(task, fetchProvider = fetch) {
  const started = Date.now();
  const response = await fetchProvider(`${task.base_url}/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${task.api_key}` },
    body: JSON.stringify({
      model: task.model,
      input: task.benchmark === 'candy' ? candyQuestion : pelicanQuestion,
      reasoning: { effort: task.reasoning_effort },
      max_output_tokens: task.benchmark === 'candy' ? 1600 : 12000,
      store: false,
    }),
    redirect: 'manual',
    signal: AbortSignal.timeout(7 * 60 * 1000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(providerError(payload, response.status));
  if (payload.status === 'incomplete') throw new Error('模型输出达到长度限制，请重试');
  if (payload.status !== 'completed' && payload.status !== undefined) throw new Error('模型没有完成回答');
  const output = extractOutputText(payload).trim();
  if (!output) throw new Error('模型没有返回可用内容');
  return {
    output,
    duration_ms: Date.now() - started,
    input_tokens: Number(payload.usage?.input_tokens) || 0,
    output_tokens: Number(payload.usage?.output_tokens) || 0,
  };
}

export function judgeCandy(output) {
  const answer = output.trim();
  return /(?:^|[^\d])21(?:[^\d]|$)/u.test(answer) && !/\b(?:not|不是|不等于)\s*21\b/iu.test(answer)
    ? 'passed' : 'incorrect';
}

export function extractHtml(output) {
  const unfenced = output.trim().replace(/^```(?:html)?\s*/i, '').replace(/\s*```$/, '');
  const start = unfenced.search(/<!doctype\s+html|<html\b/i);
  const end = unfenced.toLowerCase().lastIndexOf('</html>');
  if (start < 0 || end < start || end + 7 - start > 500_000) return '';
  return unfenced.slice(start, end + 7);
}

export function assessPelican(html) {
  if (!html) return { quality: 'degraded', reason: '没有返回完整的 HTML 作品' };
  const dynamic = /@keyframes|requestAnimationFrame|setInterval\s*\(/i.test(html);
  const wheels = (html.match(/<circle\b/gi) ?? []).length >= 2 || /wheel|车轮|轮子/i.test(html);
  const bird = /pelican|鹈鹕|\b(beak|pouch)\b|喙|喉囊/i.test(html);
  if (dynamic && wheels && bird) return { quality: 'normal', reason: '包含动画、车轮和鹈鹕结构；可查看下方浏览器画面' };
  return { quality: 'suspicious', reason: '作品已生成，部分动画或造型结构未能确认；请查看画面' };
}

export async function renderScreenshot(html, id, dataDir) {
  const { chromium } = await import('playwright');
  const folder = join(dataDir, 'screenshots');
  await mkdir(folder, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    args: typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox'] : [],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 900, height: 600 }, serviceWorkers: 'block' });
    await context.route('**/*', (route) => route.abort());
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.waitForTimeout(800);
    const path = join(folder, `${id}.png`);
    await page.screenshot({ path, animations: 'allow', timeout: 15_000 });
    await context.close();
    return path;
  } finally {
    await browser.close();
  }
}

"use client";

import { useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Braces,
  Check,
  CircleGauge,
  Clock3,
  Code2,
  Eye,
  KeyRound,
  LoaderCircle,
  Menu,
  Network,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  TestTube2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Benchmark = "reasoning" | "frontend";
type RunState = "idle" | "submitting" | "polling" | "success" | "error";
type JsonRecord = Record<string, unknown>;

const steps = ["验证接口", "执行测试", "分析结果", "生成报告"];
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function readableError(value: unknown, fallback: string) {
  if (typeof value === "string" && value.trim()) return value;
  const record = asRecord(value);
  if (typeof record.message === "string") return record.message;
  return fallback;
}

export function BanbanWorkbench() {
  const [benchmark, setBenchmark] = useState<Benchmark>("reasoning");
  const [baseUrl, setBaseUrl] = useState("https://api.banban.plus/v1");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [manualModel, setManualModel] = useState(false);
  const [effort, setEffort] = useState("medium");
  const [modelLoading, setModelLoading] = useState(false);
  const [modelMessage, setModelMessage] = useState("");
  const [runState, setRunState] = useState<RunState>("idle");
  const [task, setTask] = useState<JsonRecord | null>(null);
  const [runError, setRunError] = useState("");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const modelIsGpt = /(^|\/)gpt-/i.test(selectedModel.trim());
  const credentialsReady = baseUrl.startsWith("https://") && apiKey.trim().length > 5;
  const ready = credentialsReady && modelIsGpt && !["submitting", "polling"].includes(runState);

  const result = useMemo(() => {
    const candy = asRecord(task?.candy);
    const assessment = asRecord(task?.assessment);
    const generated = asRecord(task?.result);
    const candyStatus = candy.status;
    const quality = assessment.quality;

    let label = "等待检测";
    let tone = "idle";
    let summary = "获取模型并发起测试后，这里会显示判定结果。";

    if (runState === "submitting") {
      label = "正在启动";
      tone = "running";
      summary = "正在验证接口并准备本次检测。";
    } else if (runState === "polling") {
      label = task?.phase === "classifying" ? "正在判定" : "正在生成";
      tone = "running";
      summary = task?.phase === "classifying" ? "作品已经生成，正在分析完成质量。" : "正在等待 GPT 返回测试结果。";
    } else if (runState === "error") {
      label = "检测失败";
      tone = "error";
      summary = runError || "检测过程中出现异常。";
    } else if (benchmark === "reasoning" && task) {
      if (candyStatus === "passed") {
        label = "通过";
        tone = "pass";
        summary = "模型回答中包含正确结果 21。";
      } else if (candyStatus === "incorrect") {
        label = "未通过";
        tone = "degraded";
        summary = "模型回答未命中这道固定逻辑题的正确结果。";
      } else {
        label = "无法判定";
        tone = "unknown";
        summary = readableError(candy.error, "检测服务没有给出有效判定。");
      }
    } else if (benchmark === "frontend" && task) {
      if (quality === "normal") {
        label = "表现正常";
        tone = "pass";
      } else if (quality === "degraded" || quality === "suspicious") {
        label = "疑似降智";
        tone = "degraded";
      } else {
        label = "无法判定";
        tone = "unknown";
      }
      summary = readableError(assessment.reason, "分类服务没有提供详细原因。");
    }

    const duration = Number(candy.duration_ms ?? generated.duration_ms ?? task?.duration_ms ?? 0);
    const inputTokens = Number(candy.input_tokens ?? generated.input_tokens ?? 0);
    const outputTokens = Number(candy.output_tokens ?? generated.output_tokens ?? 0);

    return { label, tone, summary, duration, inputTokens, outputTokens };
  }, [benchmark, runError, runState, task]);

  const pelicanHtml = useMemo(() => {
    if (benchmark !== "frontend" || runState !== "success") return "";
    const generated = asRecord(task?.result);
    return typeof generated.html === "string" ? generated.html.trim() : "";
  }, [benchmark, runState, task]);

  function resetModels() {
    setModels([]);
    setSelectedModel("");
    setModelMessage("");
    setTask(null);
    setRunState("idle");
  }

  async function fetchModels() {
    if (!credentialsReady) {
      setModelMessage("请先填写有效的 HTTPS 接口地址和 API Key。");
      return;
    }

    setModelLoading(true);
    setModelMessage("");
    setModels([]);
    setSelectedModel("");

    try {
      const response = await fetch("/api/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl, apiKey }),
      });
      const data = (await response.json()) as { models?: string[]; error?: string };
      if (!response.ok) throw new Error(data.error || "模型列表读取失败");
      if (!data.models?.length) {
        throw new Error("这个接口没有返回可用的 GPT 模型，可尝试手动填写模型名称。");
      }
      setModels(data.models);
      setSelectedModel(data.models[0]);
      setManualModel(false);
      setModelMessage(`已找到 ${data.models.length} 个 GPT 模型。`);
    } catch (error) {
      setModelMessage(error instanceof Error ? error.message : "模型列表读取失败");
    } finally {
      setModelLoading(false);
    }
  }

  async function pollTask(id: string) {
    for (let attempt = 0; attempt < 180; attempt += 1) {
      await wait(3000);
      const response = await fetch(`/api/tests/${encodeURIComponent(id)}`, { cache: "no-store" });
      const data = (await response.json()) as JsonRecord;
      if (!response.ok) throw new Error(readableError(data.error, "查询检测结果失败"));
      setTask(data);
      if (["succeeded", "failed", "cancelled"].includes(String(data.status))) return data;
    }
    throw new Error("检测等待超过 9 分钟，请稍后重新尝试。");
  }

  async function startTest() {
    if (!ready) return;
    setTask(null);
    setRunError("");
    setRunState("submitting");

    try {
      const response = await fetch("/api/tests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl, apiKey, model: selectedModel.trim(), benchmark, reasoningEffort: effort }),
      });
      const created = (await response.json()) as JsonRecord;
      if (!response.ok) throw new Error(readableError(created.error, "检测任务创建失败"));
      if (typeof created.id !== "string") throw new Error("检测服务没有返回任务 ID");

      setTask(created);
      setRunState("polling");
      const completed = await pollTask(created.id);
      if (completed.status !== "succeeded") {
        throw new Error(readableError(completed.error, "检测任务未能完成"));
      }
      setTask(completed);
      setRunState("success");
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "检测失败，请稍后重试");
      setRunState("error");
    }
  }

  function changeBenchmark(value: string) {
    const next = value as Benchmark;
    setBenchmark(next);
    setEffort(next === "reasoning" ? "medium" : "low");
    setTask(null);
    setRunState("idle");
    setRunError("");
  }

  const activeStep = runState === "idle" ? -1 : runState === "submitting" ? 0 : task?.phase === "classifying" ? 2 : runState === "success" ? 3 : 1;

  return (
    <main id="main-content" className="min-h-screen bg-background text-foreground">
      <a className="skip-link" href="#workbench">跳到检测表单</a>
      <header className="site-header">
        <div className="header-inner">
          <a className="brand" href="#top" aria-label="办办AI 首页">
            <span className="brand-mark" aria-hidden="true"><span>办</span><span>办</span></span>
            <span>办办<span className="brand-ai">AI</span></span>
          </a>
          <nav className="desktop-nav" aria-label="主导航">
            <a className="nav-active" href="#workbench">GPT 检测</a>
            <a href="#method">判定方式</a>
            <a href="#reports">检测结果</a>
          </nav>
          <div className="header-actions">
            <span className="system-pill"><span />GPT 专用检测</span>
            <button className="mobile-menu" type="button" aria-label="打开导航" aria-expanded={mobileNavOpen} onClick={() => setMobileNavOpen((value) => !value)}>
              <Menu aria-hidden="true" />
            </button>
          </div>
        </div>
        {mobileNavOpen && (
          <nav className="mobile-nav" aria-label="手机导航">
            <a href="#workbench">GPT 检测</a><a href="#method">判定方式</a><a href="#reports">检测结果</a>
          </nav>
        )}
      </header>

      <section className="intro" id="top">
        <div>
          <p className="intro-kicker"><TestTube2 aria-hidden="true" /> GPT 接口能力检测</p>
          <h1>你的 GPT，<br />到底满不满血。</h1>
        </div>
        <p className="intro-copy">
          读取接口实际开放的 GPT 模型，用固定推理题和单页动画题检测输出质量。结果只代表本次测试，不用于证明模型身份。
        </p>
      </section>

      <section className="workbench" id="workbench" aria-label="GPT 检测工作台">
        <div className="config-panel">
          <div className="panel-heading">
            <div><span className="section-index">检测配置</span><h2>发起 GPT 检测</h2></div>
            <span className="draft-badge">GPT 专用</span>
          </div>

          <Tabs value={benchmark} onValueChange={changeBenchmark}>
            <TabsList className="benchmark-tabs" aria-label="选择检测项目">
              <TabsTrigger value="reasoning"><Sparkles aria-hidden="true" />糖果推理</TabsTrigger>
              <TabsTrigger value="frontend"><Code2 aria-hidden="true" />单页动画</TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="benchmark-note">
            <span className="note-icon">{benchmark === "reasoning" ? <CircleGauge aria-hidden="true" /> : <Braces aria-hidden="true" />}</span>
            <div>
              <strong>{benchmark === "reasoning" ? "固定答案逻辑题" : "鹈鹕骑自行车动画题"}</strong>
              <p>{benchmark === "reasoning" ? "回答中出现独立的 21 即通过，用于检测固定推理题表现。" : "生成单文件 HTML，由办办AI检测引擎判定正常、疑似降智或无法判定。"}</p>
            </div>
          </div>

          <div className="form-grid">
            <div className="field field-wide">
              <Label htmlFor="base-url">接口地址</Label>
              <div className="field-control">
                <Network aria-hidden="true" />
                <Input id="base-url" inputMode="url" value={baseUrl} onChange={(event) => { setBaseUrl(event.target.value); resetModels(); }} placeholder="https://api.banban.plus/v1" />
              </div>
            </div>

            <div className="field field-wide">
              <div className="label-row"><Label htmlFor="api-key">API Key</Label><span>不写入浏览器缓存</span></div>
              <div className="field-control">
                <KeyRound aria-hidden="true" />
                <Input id="api-key" type="password" autoComplete="off" value={apiKey} onChange={(event) => { setApiKey(event.target.value); resetModels(); }} placeholder="sk-••••••••••••••••" />
              </div>
            </div>

            <div className="model-discovery field-wide">
              <Button type="button" variant="outline" className="fetch-models" disabled={!credentialsReady || modelLoading} onClick={fetchModels}>
                {modelLoading ? <LoaderCircle className="spin" aria-hidden="true" /> : <Search aria-hidden="true" />}
                {modelLoading ? "正在读取" : models.length ? "重新获取模型" : "一键获取 GPT 模型"}
              </Button>
              <button className="manual-link" type="button" onClick={() => { setManualModel((value) => !value); setSelectedModel(""); setModelMessage(""); }}>
                {manualModel ? "返回模型列表" : "无法读取？手动填写"}
              </button>
            </div>

            <div className="field field-wide">
              <Label htmlFor="model">GPT 模型</Label>
              {manualModel ? (
                <div className="field-control"><Braces aria-hidden="true" /><Input id="model" value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)} placeholder="例如 gpt-6-astra" /></div>
              ) : (
                <NativeSelect id="model" className="model-select" value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)} disabled={!models.length} aria-describedby="model-help">
                  <NativeSelectOption value="">{models.length ? "请选择 GPT 模型" : "请先获取模型"}</NativeSelectOption>
                  {models.map((model) => <NativeSelectOption key={model} value={model}>{model}</NativeSelectOption>)}
                </NativeSelect>
              )}
              <p id="model-help" aria-live="polite" className={`field-message ${modelMessage && !models.length ? "field-error" : ""}`}>{modelMessage || "仅展示 GPT 文本与推理模型。"}</p>
            </div>

            <div className="field field-wide">
              <Label htmlFor="effort">推理程度</Label>
              <NativeSelect id="effort" className="model-select" value={effort} onChange={(event) => setEffort(event.target.value)}>
                <NativeSelectOption value="low">低</NativeSelectOption>
                <NativeSelectOption value="medium">中等</NativeSelectOption>
                <NativeSelectOption value="high">高</NativeSelectOption>
                {benchmark === "reasoning" && <NativeSelectOption value="xhigh">超高</NativeSelectOption>}
                {benchmark === "reasoning" && <NativeSelectOption value="max">最大</NativeSelectOption>}
                {benchmark === "reasoning" && <NativeSelectOption value="ultra">极限</NativeSelectOption>}
              </NativeSelect>
            </div>
          </div>

          <div className="security-note">
            <ShieldCheck aria-hidden="true" />
            <span>接口地址、模型名和 API Key 仅用于本次检测；办办AI不会保存你的密钥。</span>
          </div>

          <Button className="start-button" size="lg" disabled={!ready} onClick={startTest}>
            {["submitting", "polling"].includes(runState) ? "检测进行中" : "开始检测"}
            {["submitting", "polling"].includes(runState) ? <LoaderCircle className="spin" aria-hidden="true" /> : <ArrowUpRight aria-hidden="true" />}
          </Button>
        </div>

        <div className={`result-panel result-${result.tone}`} id="reports" aria-live="polite">
          <div className="result-topline">
            <div><span className="section-index">本次结果</span><h2>{selectedModel || "等待选择模型"}</h2></div>
            <span className={`status-orb status-${result.tone}`} aria-label={result.label} />
          </div>

          <div className="score-dial" aria-label={`检测结果：${result.label}`}>
            <div className="dial-inner"><strong>{result.label}</strong><span>{benchmark === "reasoning" ? "逻辑题判定" : "作品质量判定"}</span></div>
          </div>

          <p className="result-summary">
            {result.tone === "error" && <AlertTriangle aria-hidden="true" />}
            {result.summary}
          </p>

          {benchmark === "frontend" && runState === "success" && (
            <section className="pelican-preview" aria-label="鹈鹕作品浏览器预览">
              <div className="preview-chrome">
                <span className="preview-lights" aria-hidden="true"><i /><i /><i /></span>
                <span className="preview-address">模型生成作品 · 安全沙箱</span>
                <span className="preview-live">实时预览</span>
              </div>
              {pelicanHtml ? (
                <iframe
                  className="pelican-frame"
                  title="模型生成的鹈鹕骑自行车动画"
                  srcDoc={pelicanHtml}
                  sandbox="allow-scripts"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="preview-missing">
                  <Braces aria-hidden="true" />
                  <strong>本次结果没有返回可预览的 HTML</strong>
                  <span>仍可参考上方质量判定；重新检测可能获得完整作品。</span>
                </div>
              )}
            </section>
          )}

          <div className="metric-row">
            <div><Clock3 aria-hidden="true" /><span>响应耗时</span><strong>{result.duration ? `${(result.duration / 1000).toFixed(1)} s` : "—"}</strong></div>
            <div><Activity aria-hidden="true" /><span>输入 Token</span><strong>{result.inputTokens ? result.inputTokens.toLocaleString() : "—"}</strong></div>
            <div><Braces aria-hidden="true" /><span>输出 Token</span><strong>{result.outputTokens ? result.outputTokens.toLocaleString() : "—"}</strong></div>
          </div>

          <ol className="run-steps">
            {steps.map((step, index) => {
              const completed = runState === "success" || index < activeStep;
              const current = index === activeStep && !["success", "error"].includes(runState);
              return (
                <li key={step} className={current ? "step-current" : completed ? "step-complete" : ""}>
                  <span>{completed ? <Check aria-hidden="true" /> : current ? <RefreshCw className="spin" aria-hidden="true" /> : index + 1}</span>
                  <p><strong>{step}</strong><small>{completed ? "已完成" : current ? "正在处理" : "等待运行"}</small></p>
                </li>
              );
            })}
          </ol>
        </div>
      </section>

      <section className="foundation-grid" id="method" aria-label="检测判定方式">
        <article><Eye aria-hidden="true" /><div><h3>只测试 GPT</h3><p>自动读取接口模型，并过滤非 GPT 与音频、图像等非文本模型。</p></div></article>
        <article><CircleGauge aria-hidden="true" /><div><h3>固定题目判定</h3><p>糖果题检查正确结果；动画题由办办AI检测引擎分析完成质量。</p></div></article>
        <article><ShieldCheck aria-hidden="true" /><div><h3>结果不等于验真</h3><p>测试反映本次接口输出水平，不能证明中转服务实际使用的模型身份。</p></div></article>
      </section>

      <footer>
        <a className="brand footer-brand" href="#top"><span>办办</span><span className="brand-ai">AI</span></a>
        <p>GPT 接口能力检测</p><p>由办办AI检测引擎提供判定</p>
      </footer>
    </main>
  );
}

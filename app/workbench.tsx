"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Braces,
  Check,
  CircleGauge,
  Clock3,
  Code2,
  KeyRound,
  LoaderCircle,
  Network,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toChineseError } from "@/lib/user-facing-error";

type Benchmark = "reasoning" | "frontend";
type RunState = "idle" | "submitting" | "polling" | "success" | "error";
type JsonRecord = Record<string, unknown>;
type TestRun = {
  runState: RunState;
  task: JsonRecord | null;
  taskId: string;
  runError: string;
  model: string;
  startedAt: number;
};
type TestRuns = Record<Benchmark, TestRun>;

const steps = ["验证接口", "执行测试", "分析结果", "生成报告"];
const storedRunsKey = "banban-ai:test-runs:v1";
const emptyRun = (): TestRun => ({ runState: "idle", task: null, taskId: "", runError: "", model: "", startedAt: 0 });
const emptyRuns = (): TestRuns => ({ reasoning: emptyRun(), frontend: emptyRun() });

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function readableError(value: unknown, fallback: string) {
  return toChineseError(value, fallback);
}

export function BanbanWorkbench() {
  const [benchmark, setBenchmark] = useState<Benchmark>("reasoning");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [manualModel, setManualModel] = useState(false);
  const [effort, setEffort] = useState("medium");
  const [modelLoading, setModelLoading] = useState(false);
  const [modelMessage, setModelMessage] = useState("");
  const [runs, setRuns] = useState<TestRuns>(emptyRuns);
  const [storageReady, setStorageReady] = useState(false);
  const [resumeTick, setResumeTick] = useState(0);
  const [baseUrlTouched, setBaseUrlTouched] = useState(false);
  const [apiKeyTouched, setApiKeyTouched] = useState(false);

  const currentRun = runs[benchmark];
  const { runState, task, runError } = currentRun;

  const patchRun = useCallback((kind: Benchmark, patch: Partial<TestRun>) => {
    setRuns((previous) => ({ ...previous, [kind]: { ...previous[kind], ...patch } }));
  }, []);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(storedRunsKey);
      if (stored) {
        const parsed = JSON.parse(stored) as Partial<TestRuns>;
        const restored = emptyRuns();
        for (const kind of ["reasoning", "frontend"] as const) {
          const saved = parsed[kind];
          if (!saved || typeof saved !== "object") continue;
          const validStates: RunState[] = ["idle", "submitting", "polling", "success", "error"];
          const savedState = validStates.includes(saved.runState as RunState) ? saved.runState as RunState : "idle";
          const runState = savedState === "submitting" && !saved.taskId ? "idle" : savedState;
          restored[kind] = { ...restored[kind], ...saved, runState };
        }
        setRuns(restored);
      }
    } catch {
      window.localStorage.removeItem(storedRunsKey);
    } finally {
      setStorageReady(true);
    }
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    try {
      window.localStorage.setItem(storedRunsKey, JSON.stringify(runs));
    } catch {
      // 浏览器空间不足时仍保留当前页面内的任务状态。
    }
  }, [runs, storageReady]);

  useEffect(() => {
    const resume = () => {
      if (document.visibilityState === "visible") setResumeTick((value) => value + 1);
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    return () => {
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", resume);
    };
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    let stopped = false;
    const timers: number[] = [];
    const controllers: AbortController[] = [];

    const schedule = (kind: Benchmark, taskId: string, delay = 0) => {
      const timer = window.setTimeout(() => void check(kind, taskId), delay);
      timers.push(timer);
    };

    const check = async (kind: Benchmark, taskId: string) => {
      if (stopped || document.visibilityState === "hidden") return;
      const controller = new AbortController();
      controllers.push(controller);
      try {
        const response = await fetch(`/api/tests/${encodeURIComponent(taskId)}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const data = (await response.json()) as JsonRecord;
        if (!response.ok) {
          const message = toChineseError(data.error, "查询检测结果失败，请稍后重试", response.status, "poll");
          if (response.status >= 500 || response.status === 429) {
            if (!stopped) schedule(kind, taskId, 5000);
            return;
          }
          patchRun(kind, { runState: "error", runError: message, task: data });
          return;
        }

        const status = String(data.status);
        if (status === "succeeded") {
          patchRun(kind, { runState: "success", runError: "", task: data });
          return;
        }
        if (["failed", "cancelled"].includes(status)) {
          patchRun(kind, {
            runState: "error",
            runError: toChineseError(data.error, "检测任务未能完成，请重新尝试", undefined, "test"),
            task: data,
          });
          return;
        }

        patchRun(kind, { runState: "polling", task: data });
        if (!stopped) schedule(kind, taskId, 3000);
      } catch (error) {
        if (!stopped && !(error instanceof DOMException && error.name === "AbortError")) {
          schedule(kind, taskId, 5000);
        }
      }
    };

    for (const kind of ["reasoning", "frontend"] as const) {
      const run = runs[kind];
      if (run.runState === "polling" && run.taskId) schedule(kind, run.taskId);
    }

    return () => {
      stopped = true;
      timers.forEach((timer) => window.clearTimeout(timer));
      controllers.forEach((controller) => controller.abort());
    };
  }, [
    patchRun,
    resumeTick,
    runs.frontend.runState,
    runs.frontend.taskId,
    runs.reasoning.runState,
    runs.reasoning.taskId,
    storageReady,
  ]);

  const modelIsGpt = /(^|\/)gpt-/i.test(selectedModel.trim());
  const baseUrlError = !baseUrl.trim()
    ? "请输入接口地址"
    : !baseUrl.trim().startsWith("https://")
      ? "接口地址必须以 https:// 开头"
      : "";
  const apiKeyError = !apiKey.trim()
    ? "请输入 API Key"
    : apiKey.trim().length < 6
      ? "API Key 太短，请检查是否填写完整"
      : "";
  const manualModelError = manualModel && selectedModel.trim() && !modelIsGpt
    ? "目前只支持 GPT 系列，请填写 gpt- 开头的模型名"
    : "";
  const credentialsReady = !baseUrlError && !apiKeyError;
  const ready = credentialsReady && modelIsGpt && !["submitting", "polling"].includes(runState);

  const result = useMemo(() => {
    const candy = asRecord(task?.candy);
    const assessment = asRecord(task?.assessment);
    const generated = asRecord(task?.result);
    const candyStatus = candy.status;
    const quality = assessment.quality;

    let label = "等待检测";
    let tone = "idle";
    let summary = "读取模型并开始检测后，这里会显示判定结果。";

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
  }

  async function fetchModels() {
    if (!credentialsReady) {
      setBaseUrlTouched(true);
      setApiKeyTouched(true);
      setModelMessage("请先修正上面的接口地址和 API Key。");
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
      setModelMessage(toChineseError(error, "模型列表读取失败，请稍后重试", undefined, "models"));
    } finally {
      setModelLoading(false);
    }
  }

  async function startTest() {
    if (!ready) return;
    const kind = benchmark;
    const model = selectedModel.trim();
    patchRun(kind, { runState: "submitting", task: null, taskId: "", runError: "", model, startedAt: Date.now() });

    try {
      const response = await fetch("/api/tests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl, apiKey, model, benchmark: kind, reasoningEffort: effort }),
      });
      const created = (await response.json()) as JsonRecord;
      if (!response.ok) throw new Error(toChineseError(created.error, "检测任务创建失败，请稍后重试", response.status, "test"));
      if (typeof created.id !== "string") throw new Error("检测服务没有返回任务 ID");
      patchRun(kind, { runState: "polling", task: created, taskId: created.id, runError: "" });
    } catch (error) {
      patchRun(kind, {
        runState: "error",
        runError: toChineseError(error, "检测失败，请稍后重试", undefined, "test"),
      });
    }
  }

  function changeBenchmark(value: string) {
    const next = value as Benchmark;
    setBenchmark(next);
    setEffort(next === "reasoning" ? "medium" : "low");
  }

  const activeStep = runState === "idle" ? -1 : runState === "submitting" ? 0 : task?.phase === "classifying" ? 2 : runState === "success" ? 3 : 1;
  const actionHint = !credentialsReady
    ? "填写 API Key 后即可读取模型"
    : !modelIsGpt
      ? "先获取或填写一个 GPT 模型"
      : ["submitting", "polling"].includes(runState)
        ? "任务已保存，可切换项目或暂时离开页面"
        : "测试通常需要 1–5 分钟";
  const tabStatus = (kind: Benchmark) => {
    const state = runs[kind].runState;
    if (["submitting", "polling"].includes(state)) return { label: "处理中", tone: "running" };
    if (state === "success") return { label: "已完成", tone: "success" };
    if (state === "error") return { label: "失败", tone: "error" };
    return null;
  };

  return (
    <main id="main-content" className="min-h-screen bg-background text-foreground">
      <a className="skip-link" href="#workbench">跳到检测表单</a>
      <header className="site-header">
        <div className="header-inner">
          <a className="brand" href="#top" aria-label="办办AI 首页">
            <span className="brand-mark" aria-hidden="true"><span>办</span><span>办</span></span>
            <span>办办<span className="brand-ai">AI</span></span>
          </a>
          <span className="header-product">GPT 接口检测</span>
          <span className="system-status"><i aria-hidden="true" />检测服务正常</span>
        </div>
      </header>

      <section className="page-intro" id="top">
        <div>
          <h1>测一下这个 GPT 接口</h1>
          <p>选择接口实际开放的模型，跑一遍固定推理或动画测试。</p>
        </div>
        <p className="intro-note">结果只代表这一次输出，不用于证明模型身份。</p>
      </section>

      <section className="workbench" id="workbench" aria-label="GPT 检测工作台">
        <div className="config-panel">
          <div className="panel-heading">
            <div><span className="section-kicker">设置</span><h2>检测参数</h2></div>
            <span className="panel-step">01</span>
          </div>

          <Tabs value={benchmark} onValueChange={changeBenchmark}>
            <TabsList className="benchmark-tabs" aria-label="选择检测项目">
              <TabsTrigger value="reasoning">
                <Sparkles aria-hidden="true" />逻辑推理
                {tabStatus("reasoning") && <small className={`tab-status tab-status-${tabStatus("reasoning")?.tone}`}>{tabStatus("reasoning")?.label}</small>}
              </TabsTrigger>
              <TabsTrigger value="frontend">
                <Code2 aria-hidden="true" />鹈鹕动画
                {tabStatus("frontend") && <small className={`tab-status tab-status-${tabStatus("frontend")?.tone}`}>{tabStatus("frontend")?.label}</small>}
              </TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="benchmark-note">
            <span className="note-icon" aria-hidden="true">{benchmark === "reasoning" ? <CircleGauge /> : <Braces />}</span>
            <div>
              <strong>{benchmark === "reasoning" ? "糖果逻辑题" : "鹈鹕骑自行车"}</strong>
              <p>{benchmark === "reasoning" ? "检查回答是否得到固定结果 21。" : "让模型生成一页动画，并分析作品的完成质量。"}</p>
            </div>
          </div>

          <div className="form-grid">
            <div className="field field-wide">
              <Label htmlFor="base-url">接口地址</Label>
              <div className="field-control">
                <Network aria-hidden="true" />
                <Input
                  id="base-url"
                  inputMode="url"
                  value={baseUrl}
                  onBlur={() => setBaseUrlTouched(true)}
                  onChange={(event) => { setBaseUrl(event.target.value); resetModels(); }}
                  placeholder="https://api.banban.plus/v1"
                  aria-invalid={baseUrlTouched && Boolean(baseUrlError)}
                  aria-describedby="base-url-error"
                />
              </div>
              <p id="base-url-error" className="inline-error" aria-live="polite">{baseUrlTouched ? baseUrlError : ""}</p>
            </div>

            <div className="field field-wide">
              <div className="label-row"><Label htmlFor="api-key">API Key</Label><span>本次使用，不保存</span></div>
              <div className="field-control">
                <KeyRound aria-hidden="true" />
                <Input
                  id="api-key"
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  onBlur={() => setApiKeyTouched(true)}
                  onChange={(event) => { setApiKey(event.target.value); resetModels(); }}
                  placeholder="输入你的 API Key"
                  aria-invalid={apiKeyTouched && Boolean(apiKeyError)}
                  aria-describedby="api-key-error"
                />
              </div>
              <p id="api-key-error" className="inline-error" aria-live="polite">{apiKeyTouched ? apiKeyError : ""}</p>
            </div>

            <div className="model-discovery field-wide">
              <Button type="button" variant="outline" className="fetch-models" disabled={modelLoading} onClick={fetchModels}>
                {modelLoading ? <LoaderCircle className="spin" aria-hidden="true" /> : <Search aria-hidden="true" />}
                {modelLoading ? "正在读取" : models.length ? "重新读取模型" : "读取可用模型"}
              </Button>
              <button className="manual-link" type="button" onClick={() => { setManualModel((value) => !value); setSelectedModel(""); setModelMessage(""); }}>
                {manualModel ? "使用模型列表" : "手动填写模型名"}
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
              <p id="model-help" aria-live="polite" className={`field-message ${(manualModelError || (modelMessage && !models.length)) ? "field-error" : ""}`}>{manualModelError || modelMessage || "仅展示 GPT 文本与推理模型。"}</p>
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
            <span>API Key 不会保存；任务编号和结果会保存在本机，切换项目、浏览器进入后台或重新打开页面都会自动续查。</span>
          </div>

          <div className="start-row">
            <span id="action-hint">{actionHint}</span>
            <Button className="start-button" size="lg" disabled={!ready} onClick={startTest} aria-describedby="action-hint">
              {["submitting", "polling"].includes(runState) ? "正在检测" : "开始检测"}
              {["submitting", "polling"].includes(runState) ? <LoaderCircle className="spin" aria-hidden="true" /> : <ArrowUpRight aria-hidden="true" />}
            </Button>
          </div>
        </div>

        <div className={`result-panel result-${result.tone}`} id="reports" aria-live="polite">
          <div className="result-topline">
            <div><span className="section-kicker">结果</span><h2>{currentRun.model || selectedModel || "尚未选择模型"}</h2></div>
            <span className={`result-state result-state-${result.tone}`}><i aria-hidden="true" />{result.label}</span>
          </div>

          <div className="result-readout" aria-label={`检测结果：${result.label}`}>
            <span>{benchmark === "reasoning" ? "逻辑题判定" : "作品质量判定"}</span>
            <strong>{result.label}</strong>
            <p>{result.tone === "error" && <AlertTriangle aria-hidden="true" />}{result.summary}</p>
          </div>

          {benchmark === "frontend" && runState === "success" && (
            <section className="pelican-preview" aria-label="鹈鹕作品浏览器预览">
              <div className="preview-chrome">
                <span className="preview-lights" aria-hidden="true"><i /><i /><i /></span>
                <span className="preview-address">模型生成作品</span>
                <span className="preview-live">安全预览</span>
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
            <div><span><Clock3 aria-hidden="true" />响应耗时</span><strong>{result.duration ? `${(result.duration / 1000).toFixed(1)} s` : "—"}</strong></div>
            <div><span><Activity aria-hidden="true" />输入 Token</span><strong>{result.inputTokens ? result.inputTokens.toLocaleString() : "—"}</strong></div>
            <div><span><Braces aria-hidden="true" />输出 Token</span><strong>{result.outputTokens ? result.outputTokens.toLocaleString() : "—"}</strong></div>
          </div>

          <ol className="run-steps">
            {steps.map((step, index) => {
              const completed = runState === "success" || index < activeStep;
              const current = index === activeStep && !["success", "error"].includes(runState);
              return (
                <li key={step} className={current ? "step-current" : completed ? "step-complete" : ""}>
                  <span>{completed ? <Check aria-hidden="true" /> : current ? <RefreshCw className="spin" aria-hidden="true" /> : index + 1}</span>
                  <p><strong>{step}</strong><small>{completed ? "完成" : current ? "进行中" : "等待"}</small></p>
                </li>
              );
            })}
          </ol>
        </div>
      </section>

      <section className="method-notes" id="method" aria-label="检测判定方式">
        <h2>这份结果怎么看</h2>
        <div className="method-list">
          <article><span>01</span><div><h3>只显示 GPT</h3><p>模型列表会过滤音频、图像和其他非 GPT 模型。</p></div></article>
          <article><span>02</span><div><h3>题目保持固定</h3><p>同一测试使用同一判定标准，方便比较不同接口。</p></div></article>
          <article><span>03</span><div><h3>结果不是验真</h3><p>它反映本次输出表现，不能证明接口背后的真实模型身份。</p></div></article>
        </div>
      </section>

      <footer>
        <a className="brand footer-brand" href="#top"><span>办办</span><span className="brand-ai">AI</span></a>
        <p>GPT 接口能力检测</p><p>结果仅供本次调用参考</p>
      </footer>
    </main>
  );
}

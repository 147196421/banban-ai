"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Braces,
  Check,
  Clock3,
  Code2,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  Network,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
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
  finishedAt: number;
};
type TestRuns = Record<Benchmark, TestRun>;
type HistoryEntry = TestRun & { benchmark: Benchmark };

const steps = ["验证接口", "执行测试", "分析结果", "生成报告"];
const storedRunsKey = "banban-ai:test-runs:v1";
const storedHistoryKey = "banban-ai:history:v1";
const storedVisitorIdKey = "banban-ai:visitor-id:v1";
const historyLimit = 30;
const historySizeLimit = 2_500_000;
const emptyRun = (): TestRun => ({ runState: "idle", task: null, taskId: "", runError: "", model: "", startedAt: 0, finishedAt: 0 });
const emptyRuns = (): TestRuns => ({ reasoning: emptyRun(), frontend: emptyRun() });

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function readableError(value: unknown, fallback: string) {
  return toChineseError(value, fallback);
}

function createSubmissionId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function createVisitorId() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => alphabet[byte % alphabet.length]).join("");
}

function validHistoryEntry(value: unknown): value is HistoryEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<HistoryEntry>;
  return (entry.benchmark === "reasoning" || entry.benchmark === "frontend")
    && typeof entry.taskId === "string"
    && /^[A-Za-z0-9_-]{1,128}$/.test(entry.taskId)
    && typeof entry.startedAt === "number"
    && Number.isFinite(entry.startedAt)
    && entry.startedAt > 0
    && typeof entry.model === "string"
    && ["submitting", "polling", "success", "error"].includes(String(entry.runState));
}

function trimHistory(entries: HistoryEntry[]) {
  const seen = new Set<string>();
  const unique = entries.filter((entry) => {
    if (!validHistoryEntry(entry) || seen.has(entry.taskId)) return false;
    seen.add(entry.taskId);
    return true;
  }).sort((a, b) => b.startedAt - a.startedAt).slice(0, historyLimit);
  while (unique.length > 1 && JSON.stringify(unique).length > historySizeLimit) unique.pop();
  return unique;
}

function mergeHistory(entries: HistoryEntry[], benchmark: Benchmark, run: TestRun) {
  if (!run.taskId || run.runState === "idle") return entries;
  return trimHistory([{ ...run, benchmark }, ...entries.filter((entry) => entry.taskId !== run.taskId)]);
}

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(timestamp);
}

function describeResult(run: TestRun, benchmark: Benchmark) {
  const { runState, task, runError } = run;
  const candy = asRecord(task?.candy);
  const assessment = asRecord(task?.assessment);
  const generated = asRecord(task?.result);
  const candyStatus = candy.status;
  const quality = assessment.quality;
  const referenceJudgment = task?.evaluation_source === "reference";

  let label = "等待检测";
  let tone = "idle";
  let summary = "";

  if (runState === "submitting" || runState === "polling") {
    label = task?.phase === "classifying" ? "正在判定" : "正在检测";
    tone = "running";
    summary = "可以离开页面，检测会继续。";
  } else if (runState === "error") {
    label = "检测失败";
    tone = "error";
    summary = runError || "请稍后重试。";
  } else if (benchmark === "reasoning" && task) {
    if (candyStatus === "passed") {
      label = "通过";
      tone = "pass";
      summary = "本次回答符合预期。";
    } else if (candyStatus === "incorrect") {
      label = "未通过";
      tone = "degraded";
      summary = "本次回答与预期不符。";
    } else {
      label = "无法判定";
      tone = "unknown";
      summary = readableError(candy.error, "本次没有有效判定。");
    }
  } else if (benchmark === "frontend" && task) {
    if (quality === "normal") {
      label = referenceJudgment ? "表现正常" : "结构完整";
      tone = "pass";
      summary = referenceJudgment
        ? readableError(assessment.reason, "本次表现符合预期。")
        : "检测到动画和主要元素，请结合截图查看。";
    } else if (quality === "degraded" || quality === "suspicious") {
      label = referenceJudgment ? "疑似降智" : "需人工查看";
      tone = "degraded";
      summary = readableError(assessment.reason, "部分结构未能确认，请查看作品。");
    } else {
      label = "无法判定";
      tone = "unknown";
      summary = readableError(assessment.reason, "本次没有详细原因。");
    }
  }

  const duration = Number(candy.duration_ms ?? generated.duration_ms ?? task?.duration_ms ?? 0);
  const inputTokens = Number(candy.input_tokens ?? generated.input_tokens ?? 0);
  const outputTokens = Number(candy.output_tokens ?? generated.output_tokens ?? 0);
  return { label, tone, summary, duration, inputTokens, outputTokens };
}

export function BanbanWorkbench() {
  const [benchmark, setBenchmark] = useState<Benchmark>("reasoning");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [manualModel, setManualModel] = useState(false);
  const [effort, setEffort] = useState("high");
  const [modelLoading, setModelLoading] = useState(false);
  const [modelMessage, setModelMessage] = useState("");
  const [runs, setRuns] = useState<TestRuns>(emptyRuns);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [visitorId, setVisitorId] = useState("");
  const [confirmingHistoryId, setConfirmingHistoryId] = useState("");
  const [selectedHistoryId, setSelectedHistoryId] = useState("");
  const [storageReady, setStorageReady] = useState(false);
  const [resumeTick, setResumeTick] = useState(0);
  const [baseUrlTouched, setBaseUrlTouched] = useState(false);
  const [apiKeyTouched, setApiKeyTouched] = useState(false);
  const deletedRunIds = useRef(new Set<string>());

  const selectedHistory = history.find((entry) => entry.taskId === selectedHistoryId && entry.benchmark === benchmark);
  const currentRun = selectedHistory || runs[benchmark];
  const { runState, task } = currentRun;

  const patchRun = useCallback((kind: Benchmark, patch: Partial<TestRun>) => {
    setRuns((previous) => ({ ...previous, [kind]: { ...previous[kind], ...patch } }));
  }, []);

  useEffect(() => {
    let restoredHistory: HistoryEntry[] = [];
    try {
      const savedId = window.localStorage.getItem(storedVisitorIdKey);
      const id = savedId && /^[A-HJ-NP-Z2-9]{8}$/.test(savedId) ? savedId : createVisitorId();
      window.localStorage.setItem(storedVisitorIdKey, id);
      // 首次挂载后从本地存储恢复访客 ID，避免服务端读取 window。
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setVisitorId(id);
    } catch {
      setVisitorId(createVisitorId());
    }
    try {
      const savedHistory = window.localStorage.getItem(storedHistoryKey);
      const parsedHistory = savedHistory ? JSON.parse(savedHistory) as unknown : [];
      restoredHistory = Array.isArray(parsedHistory) ? trimHistory(parsedHistory as HistoryEntry[]) : [];
    } catch {
      // 历史记录损坏时仍尝试恢复最新任务。
    }
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
          const runState = savedState === "submitting"
            ? saved.taskId ? "polling" : "idle"
            : savedState;
          restored[kind] = { ...restored[kind], ...saved, runState };
          restoredHistory = mergeHistory(restoredHistory, kind, restored[kind]);
        }
        // 从浏览器存储恢复一次任务快照；此处必须在挂载后运行，避免服务端读取 window。
        setRuns(restored);
      }
    } catch {
      // 存储被禁用或数据损坏时仍允许继续检测。
    } finally {
      setHistory(restoredHistory);
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
    if (!storageReady) return;
    // 轮询完成后同步更新同一浏览器的历史快照。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHistory((previous) => {
      let next = previous;
      for (const kind of ["reasoning", "frontend"] as const) next = mergeHistory(next, kind, runs[kind]);
      return next;
    });
  }, [runs, storageReady]);

  useEffect(() => {
    if (!storageReady) return;
    try {
      window.localStorage.setItem(storedHistoryKey, JSON.stringify(history));
    } catch {
      // 存储不可用时仍能在当前页面查看历史。
    }
  }, [history, storageReady]);

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
      if (stopped || deletedRunIds.current.has(taskId) || document.visibilityState === "hidden") return;
      const controller = new AbortController();
      controllers.push(controller);
      try {
        const response = await fetch(`/v1/tests/${encodeURIComponent(taskId)}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const data = (await response.json()) as JsonRecord;
        if (stopped || deletedRunIds.current.has(taskId)) return;
        if (!response.ok) {
          const message = toChineseError(data.error, "查询检测结果失败，请稍后重试", response.status, "poll");
          const startedAt = runs[kind].startedAt;
          if (response.status === 404 && startedAt && Date.now() - startedAt < 30_000) {
            if (!stopped) schedule(kind, taskId, 2000);
            return;
          }
          if (response.status >= 500 || response.status === 429) {
            if (!stopped) schedule(kind, taskId, 5000);
            return;
          }
          patchRun(kind, { runState: "error", runError: message, task: data, finishedAt: Date.now() });
          return;
        }

        const status = String(data.status);
        if (status === "succeeded") {
          patchRun(kind, { runState: "success", runError: "", task: data, finishedAt: Date.now() });
          return;
        }
        if (["failed", "cancelled"].includes(status)) {
          patchRun(kind, {
            runState: "error",
            runError: toChineseError(data.error, "检测任务未能完成，请重新尝试", undefined, "test"),
            task: data,
            finishedAt: Date.now(),
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
      if (run.runState === "polling" && run.taskId) {
        schedule(kind, run.taskId, run.task?.phase === "creating" ? 1200 : 0);
      }
    }

    return () => {
      stopped = true;
      timers.forEach((timer) => window.clearTimeout(timer));
      controllers.forEach((controller) => controller.abort());
    };
  // 只在任务身份或状态变化时重建轮询，避免每次服务端进度刷新都重复启动请求。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    patchRun,
    resumeTick,
    runs.frontend.runState,
    runs.frontend.taskId,
    runs.reasoning.runState,
    runs.reasoning.taskId,
    storageReady,
  ]);

  const pendingHistoryIds = history
    .filter((entry) => ["submitting", "polling"].includes(entry.runState))
    .filter((entry) => runs[entry.benchmark].taskId !== entry.taskId)
    .slice(0, 8)
    .map((entry) => entry.taskId)
    .join(",");

  useEffect(() => {
    if (!storageReady || !pendingHistoryIds) return;
    let stopped = false;
    const ids = pendingHistoryIds.split(",");
    const refresh = async () => {
      if (document.visibilityState === "hidden") return;
      await Promise.all(ids.map(async (id) => {
        try {
          const response = await fetch(`/v1/tests/${encodeURIComponent(id)}`, { cache: "no-store" });
          if (!response.ok) return;
          const task = await response.json() as JsonRecord;
          if (stopped) return;
          const status = String(task.status || "");
          setHistory((previous) => previous.map((entry) => entry.taskId !== id ? entry : {
            ...entry,
            task,
            runState: status === "succeeded" ? "success" : ["failed", "cancelled"].includes(status) ? "error" : "polling",
            runError: ["failed", "cancelled"].includes(status)
              ? toChineseError(task.error, "检测失败", undefined, "test")
              : "",
            finishedAt: ["succeeded", "failed", "cancelled"].includes(status) ? Date.now() : 0,
          }));
        } catch {
          // 网络恢复后继续查询，不覆盖已有结果。
        }
      }));
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [pendingHistoryIds, resumeTick, storageReady]);

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
  const ready = credentialsReady && modelIsGpt && !["submitting", "polling"].includes(runs[benchmark].runState);

  const result = describeResult(currentRun, benchmark);

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

  function clearCurrentResult() {
    if (selectedHistoryId) {
      setSelectedHistoryId("");
      return;
    }
    patchRun(benchmark, emptyRun());
  }

  function removeHistoryEntry(entry: HistoryEntry) {
    deletedRunIds.current.add(entry.taskId);
    const nextHistory = history.filter((item) => item.taskId !== entry.taskId);
    const nextRuns = { ...runs };
    if (nextRuns[entry.benchmark].taskId === entry.taskId) {
      nextRuns[entry.benchmark] = emptyRun();
      setRuns(nextRuns);
    }
    setHistory(nextHistory);
    if (selectedHistoryId === entry.taskId) setSelectedHistoryId("");
    setConfirmingHistoryId("");
    try {
      window.localStorage.setItem(storedHistoryKey, JSON.stringify(nextHistory));
      window.localStorage.setItem(storedRunsKey, JSON.stringify(nextRuns));
    } catch {
      // 浏览器禁用存储时仍在当前页面移除记录。
    }
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

    try {
      const response = await fetch("/v1/models", {
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
    const submissionId = createSubmissionId();
    const startedAt = Date.now();
    const queuedTask = { id: submissionId, status: "queued", phase: "creating" };
    const queuedRun: TestRun = {
      runState: "polling",
      task: queuedTask,
      taskId: submissionId,
      runError: "",
      model,
      startedAt,
      finishedAt: 0,
    };

    // 在网络请求前同步保存任务编号，手机立即进入后台或页面被系统回收也能恢复。
    try {
      const stored = window.localStorage.getItem(storedRunsKey);
      const saved = stored ? JSON.parse(stored) as Partial<TestRuns> : {};
      window.localStorage.setItem(storedRunsKey, JSON.stringify({ ...saved, [kind]: queuedRun }));
      const priorHistory = window.localStorage.getItem(storedHistoryKey);
      const parsedHistory = priorHistory ? JSON.parse(priorHistory) as unknown : [];
      const entries = Array.isArray(parsedHistory) ? parsedHistory as HistoryEntry[] : [];
      window.localStorage.setItem(storedHistoryKey, JSON.stringify(mergeHistory(entries, kind, queuedRun)));
    } catch {
      // 浏览器禁止本地存储时仍继续当前页面内的检测。
    }
    setSelectedHistoryId("");
    patchRun(kind, queuedRun);

    try {
      const response = await fetch("/v1/tests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ submissionId, baseUrl, apiKey, model, benchmark: kind, reasoningEffort: effort }),
        keepalive: true,
      });
      const created = (await response.json()) as JsonRecord;
      if (deletedRunIds.current.has(submissionId)) return;
      if (!response.ok) {
        patchRun(kind, {
          runState: "error",
          task: created,
          runError: toChineseError(created.error, "检测任务创建失败，请稍后重试", response.status, "test"),
          finishedAt: Date.now(),
        });
        return;
      }
      if (typeof created.id !== "string") {
        patchRun(kind, { runState: "error", runError: "检测服务没有返回任务 ID", finishedAt: Date.now() });
        return;
      }
      patchRun(kind, { runState: "polling", task: created, taskId: submissionId, runError: "" });
    } catch {
      // 请求可能已到达服务器但浏览器在后台丢失了响应；保留任务编号并由轮询确认最终状态。
      if (deletedRunIds.current.has(submissionId)) return;
      patchRun(kind, { runState: "polling", task: queuedTask, taskId: submissionId, runError: "" });
    }
  }

  function changeBenchmark(value: string) {
    const next = value as Benchmark;
    setBenchmark(next);
    setSelectedHistoryId("");
    setEffort("high");
  }

  const activeStep = runState === "idle" ? -1 : runState === "submitting" || task?.phase === "creating" ? 0 : task?.phase === "classifying" ? 2 : runState === "success" ? 3 : 1;
  const hasFinishedRun = ["success", "error"].includes(runState);
  const latestRunState = runs[benchmark].runState;
  const actionHint = !credentialsReady ? "" : !modelIsGpt ? "选择 GPT 模型" : ["submitting", "polling"].includes(latestRunState) ? "后台可继续" : "约 1–5 分钟";
  return (
    <main id="main-content" className="min-h-screen bg-background text-foreground">
      <a className="skip-link" href="#workbench">跳到检测表单</a>
      <header className="site-header">
        <div className="header-inner">
          <a className="brand" href="#top" aria-label="办办AI 首页">
            <span className="brand-mark" aria-hidden="true" />
            <span>办办<span className="brand-ai">AI</span></span>
          </a>
          <a className="header-history" href="#history">历史记录</a>
        </div>
      </header>

      <section className="page-intro" id="top">
        <h1>GPT 接口检测</h1>
      </section>

      <section className="workbench" id="workbench" aria-label="GPT 检测工作台">
        <div className="config-panel">
          <div className="panel-heading"><h2>检测参数</h2></div>

          <Tabs value={benchmark} onValueChange={changeBenchmark}>
            <TabsList className="benchmark-tabs" aria-label="选择检测项目">
              <TabsTrigger value="reasoning">
                <Sparkles aria-hidden="true" />糖果测试
              </TabsTrigger>
              <TabsTrigger value="frontend">
                <Code2 aria-hidden="true" />鹈鹕骑行
              </TabsTrigger>
            </TabsList>
          </Tabs>

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
                  type={apiKeyVisible ? "text" : "password"}
                  autoComplete="off"
                  value={apiKey}
                  onBlur={() => setApiKeyTouched(true)}
                  onChange={(event) => { setApiKey(event.target.value); resetModels(); }}
                  placeholder="输入你的 API Key"
                  aria-invalid={apiKeyTouched && Boolean(apiKeyError)}
                  aria-describedby="api-key-error"
                />
                <button
                  className="input-action"
                  type="button"
                  aria-label={apiKeyVisible ? "隐藏密钥" : "显示密钥"}
                  aria-pressed={apiKeyVisible}
                  onClick={() => setApiKeyVisible((visible) => !visible)}
                >
                  {apiKeyVisible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                </button>
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
                <NativeSelect id="model" className="model-select" value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)} disabled={!models.length} aria-describedby={modelMessage ? "model-help" : undefined}>
                  <NativeSelectOption value="">{models.length ? "请选择 GPT 模型" : "请先获取模型"}</NativeSelectOption>
                  {models.map((model) => <NativeSelectOption key={model} value={model}>{model}</NativeSelectOption>)}
                </NativeSelect>
              )}
              {(manualModelError || modelMessage) && <p id="model-help" aria-live="polite" className={`field-message ${(manualModelError || (modelMessage && !models.length)) ? "field-error" : ""}`}>{manualModelError || modelMessage}</p>}
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

          <div className="start-row">
            <span id="action-hint">{actionHint}</span>
            <Button className="start-button" size="lg" disabled={!ready} onClick={startTest} aria-describedby="action-hint">
              {["submitting", "polling"].includes(latestRunState) ? "正在检测" : ["success", "error"].includes(latestRunState) ? "重新检测" : "开始检测"}
              {["submitting", "polling"].includes(latestRunState)
                ? <LoaderCircle className="spin" aria-hidden="true" />
                : ["success", "error"].includes(latestRunState)
                  ? <RotateCcw aria-hidden="true" />
                  : <ArrowUpRight aria-hidden="true" />}
            </Button>
          </div>
        </div>

        <div className={`result-panel result-${result.tone}`} id="reports" aria-live="polite">
          <div className="result-topline">
            <div><span className="section-kicker">{selectedHistoryId ? "历史结果" : "结果"}</span><h2>{currentRun.model || selectedModel || "尚未选择模型"}</h2></div>
            <div className="result-actions">
              {(hasFinishedRun || selectedHistoryId) && (
                <button className="clear-result" type="button" onClick={clearCurrentResult}>
                  <RotateCcw aria-hidden="true" />{selectedHistoryId ? "返回最新" : "收起"}
                </button>
              )}
              <span className={`result-state result-state-${result.tone}`}><i aria-hidden="true" />{result.label}</span>
            </div>
          </div>

          <div className="result-readout" aria-label={`检测结果：${result.label}`}>
            <span>{benchmark === "reasoning" ? "逻辑题判定" : task?.evaluation_source === "reference" ? "作品质量判定" : "作品结构检查"}</span>
            <strong>{result.label}</strong>
            {result.summary && <p>{result.tone === "error" && <AlertTriangle aria-hidden="true" />}{result.summary}</p>}
          </div>

          {currentRun.startedAt > 0 && (
            <div className="run-timestamps">
              <span>开始 <time dateTime={new Date(currentRun.startedAt).toISOString()}>{formatTime(currentRun.startedAt)}</time></span>
              {currentRun.finishedAt > 0 && <span>完成 <time dateTime={new Date(currentRun.finishedAt).toISOString()}>{formatTime(currentRun.finishedAt)}</time></span>}
            </div>
          )}

          {benchmark === "frontend" && runState === "success" && (
            <section className="pelican-preview" aria-label="鹈鹕作品浏览器预览">
              {typeof asRecord(task?.result).screenshot_url === "string" && currentRun.taskId ? (
                <div className="pelican-snapshot">
                  <span>浏览器截图</span>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/v1/tests/${encodeURIComponent(currentRun.taskId)}/screenshot`} alt="鹈鹕骑行作品的实际浏览器截图" loading="lazy" />
                </div>
              ) : (
                <>
                  {typeof asRecord(task?.result).screenshot_error === "string" && (
                    <p className="field-message field-error" role="status">浏览器截图暂时不可用，已显示动画预览。</p>
                  )}
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
                      <span>可重新检测，尝试生成完整作品。</span>
                    </div>
                  )}
                </>
              )}
            </section>
          )}

          <div className="metric-row">
            <div><span><Clock3 aria-hidden="true" />响应耗时</span><strong>{result.duration ? `${(result.duration / 1000).toFixed(1)} s` : "—"}</strong></div>
            <div><span><Activity aria-hidden="true" />输入 Token</span><strong>{result.inputTokens ? result.inputTokens.toLocaleString() : "—"}</strong></div>
            <div><span><Braces aria-hidden="true" />输出 Token</span><strong>{result.outputTokens ? result.outputTokens.toLocaleString() : "—"}</strong></div>
          </div>

          {["submitting", "polling"].includes(runState) && <ol className="run-steps">
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
          </ol>}
          <section className="history-section" id="history" aria-label="浏览器历史记录">
            <div className="history-heading"><h2>历史记录</h2><span>访客 ID：{visitorId || "········"} · {history.length}/30</span></div>
            {history.length ? (
              <div className="history-list">
                {history.map((entry) => {
                  const item = describeResult(entry, entry.benchmark);
                  return (
                    <div className="history-row" key={entry.taskId}>
                      <button
                        type="button"
                        className="history-item"
                        aria-pressed={selectedHistoryId === entry.taskId}
                        onClick={() => {
                          setBenchmark(entry.benchmark);
                          setSelectedHistoryId(entry.taskId);
                          setEffort("high");
                          document.getElementById("reports")?.scrollIntoView({ behavior: "smooth", block: "start" });
                        }}
                      >
                        <span className="history-main"><strong>{entry.model}</strong><small>{entry.benchmark === "reasoning" ? "糖果" : "鹈鹕"}</small></span>
                        <time dateTime={new Date(entry.startedAt).toISOString()}>{formatTime(entry.startedAt)}</time>
                        <span className={`history-status history-status-${item.tone}`}>{item.label}</span>
                      </button>
                      <div className="history-delete-actions">
                        <button type="button" className="history-delete" aria-label={confirmingHistoryId === entry.taskId ? `确认删除 ${entry.model} 的记录` : `删除 ${entry.model} 的记录`} onClick={() => confirmingHistoryId === entry.taskId ? removeHistoryEntry(entry) : setConfirmingHistoryId(entry.taskId)}>
                          {confirmingHistoryId === entry.taskId ? "确定" : <><Trash2 aria-hidden="true" />删除</>}
                        </button>
                        {confirmingHistoryId === entry.taskId && <button type="button" className="history-cancel" onClick={() => setConfirmingHistoryId("")}>取消</button>}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : <p className="history-empty">检测后会显示在这里。</p>}
          </section>
        </div>
      </section>

      <footer>
        <a className="brand footer-brand" href="#top"><span>办办</span><span className="brand-ai">AI</span></a>
        <p>结果仅供参考</p>
      </footer>
    </main>
  );
}

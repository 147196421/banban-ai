"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, Braces, Check, Code2, Copy, FileText, Image as ImageIcon, Monitor, X } from "lucide-react";

const canvasWidth = 1280;
const canvasHeight = 960;
const fixedPromptSummary = "请生成可直接运行的单文件HTML，使用内联SVG绘制鹈鹕骑自行车的二维循环动画。画面以鹈鹕和自行车为主体，展示清晰的身体结构、踩踏动作和车轮转动，配合协调的背景、配色与层次。动画应流畅自然、衔接连续，并适配不同屏幕尺寸。禁止依赖外部资源，只输出完整HTML，不要代码围栏或解释文字。";
type DetailMode = "work" | "code" | "prompt" | "screenshot";

type Props = {
  html: string;
  prompt?: string;
  screenshotUrl?: string;
  screenshotError?: boolean;
};

function useElementWidth() {
  const [width, setWidth] = useState(0);
  const measure = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [measure, width] as const;
}

export function PelicanPreview({ html, prompt, screenshotUrl, screenshotError }: Props) {
  const [imageFailed, setImageFailed] = useState(false);
  const [detailMode, setDetailMode] = useState<DetailMode>("work");
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");
  const dialog = useRef<HTMLDialogElement>(null);
  const [thumbnailRef, thumbnailWidth] = useElementWidth();
  const [fullRef, fullWidth] = useElementWidth();
  const hasScreenshot = Boolean(screenshotUrl && !imageFailed);

  useEffect(() => {
    // 历史记录切换后重试新结果对应的截图。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setImageFailed(false);
  }, [screenshotUrl]);

  const renderCanvas = (width: number, interactive: boolean) => (
    <iframe
      className="pelican-canvas"
      style={{ transform: `scale(${width / canvasWidth})` }}
      title={interactive ? "鹈鹕作品完整预览" : "鹈鹕作品缩略预览"}
      srcDoc={html}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      tabIndex={interactive ? 0 : -1}
    />
  );

  const open = () => {
    setDetailMode(html ? "work" : "screenshot");
    dialog.current?.showModal();
  };

  const selectMode = (mode: DetailMode) => {
    setDetailMode(mode);
    dialog.current?.querySelector(".pelican-dialog-body")?.scrollTo(0, 0);
  };

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(html);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("error");
    }
    window.setTimeout(() => setCopyStatus("idle"), 2500);
  };

  return (
    <section className="pelican-preview" aria-label="鹈鹕作品浏览器预览">
      <div className="preview-chrome">
        <span className="preview-lights" aria-hidden="true"><i /><i /><i /></span>
        <span className="preview-address">模型生成作品</span>
        <button type="button" className="preview-expand" onClick={open} disabled={!hasScreenshot && !html}>
          查看完整作品 <ArrowUpRight aria-hidden="true" />
        </button>
      </div>
      {(screenshotError || imageFailed) && !hasScreenshot && html && (
        <p className="preview-note">截图暂不可用，已显示作品预览。</p>
      )}
      {hasScreenshot || html ? (
        <div className="preview-surface" ref={thumbnailRef}>
          {hasScreenshot ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={screenshotUrl} alt="鹈鹕骑行作品预览" loading="lazy" onError={() => setImageFailed(true)} />
          ) : thumbnailWidth > 0 ? (
            <div className="pelican-canvas-wrapper" aria-hidden="true">{renderCanvas(thumbnailWidth, false)}</div>
          ) : null}
          <button type="button" className="preview-surface-open" onClick={open} aria-label="查看完整鹈鹕作品" />
        </div>
      ) : (
        <div className="preview-missing"><Braces aria-hidden="true" /><strong>暂无可预览作品</strong></div>
      )}
      <dialog className="pelican-dialog" ref={dialog} aria-label="鹈鹕作品完整预览">
        <div className="pelican-dialog-head">
          <strong>鹈鹕骑行</strong>
          <div className="pelican-dialog-actions">
            {detailMode === "code" && html && (
              <>
                <span className="pelican-copy-feedback" role="status">{copyStatus === "copied" ? "已复制" : copyStatus === "error" ? "复制失败，请手动选择" : ""}</span>
                <button type="button" className="pelican-copy-code" onClick={() => void copyCode()} aria-label="复制源代码">
                  {copyStatus === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                </button>
              </>
            )}
            {hasScreenshot && html && (
              <button type="button" className="pelican-screenshot-link" onClick={() => selectMode(detailMode === "screenshot" ? "work" : "screenshot")} aria-label={detailMode === "screenshot" ? "返回作品" : "查看浏览器截图"} title={detailMode === "screenshot" ? "返回作品" : "查看浏览器截图"}>
                <ImageIcon aria-hidden="true" />
              </button>
            )}
            <button type="button" aria-label="关闭作品预览" onClick={() => dialog.current?.close()}><X aria-hidden="true" /></button>
          </div>
        </div>
        <div className="pelican-dialog-body" data-view={detailMode} ref={fullRef}>
          {detailMode === "code" && html ? (
            <div className="pelican-source" role="tabpanel" id="pelican-panel-code" aria-labelledby="pelican-tab-code">
              <p>本次模型返回的完整 HTML，与作品预览使用同一份内容。</p>
              <pre><code>{html}</code></pre>
            </div>
          ) : detailMode === "prompt" && html ? (
            <div className="pelican-prompt" role="tabpanel" id="pelican-panel-prompt" aria-labelledby="pelican-tab-prompt">
              <p>{prompt || fixedPromptSummary}</p>
              <small>{prompt ? "本次接口返回的测试提示词" : "标准固定测试题目 · 本次接口结果未单独返回提示词"}</small>
            </div>
          ) : detailMode === "screenshot" && hasScreenshot ? (
            <div className="pelican-screenshot-panel" role="tabpanel" id="pelican-panel-work" aria-labelledby="pelican-tab-work">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={screenshotUrl} alt="鹈鹕骑行作品完整浏览器截图" onError={() => setImageFailed(true)} />
            </div>
          ) : html && fullWidth > 0 ? (
            <div className="pelican-full-canvas" role="tabpanel" id="pelican-panel-work" aria-labelledby="pelican-tab-work" style={{ height: canvasHeight * fullWidth / canvasWidth }}>
              {renderCanvas(fullWidth, true)}
            </div>
          ) : hasScreenshot ? (
            <div className="pelican-screenshot-panel">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={screenshotUrl} alt="鹈鹕骑行作品完整浏览器截图" onError={() => setImageFailed(true)} />
            </div>
          ) : null}
        </div>
        {html && (
          <div className="pelican-view-tabs" role="tablist" aria-label="作品视图" onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const modes: DetailMode[] = ["work", "code", "prompt"];
            const current = modes.indexOf(detailMode === "screenshot" ? "work" : detailMode);
            const next = event.key === "Home" ? 0 : event.key === "End" ? 2
              : (current + (event.key === "ArrowRight" ? 1 : 2)) % 3;
            selectMode(modes[next]);
            document.getElementById(`pelican-tab-${modes[next]}`)?.focus();
          }}>
            <button type="button" role="tab" id="pelican-tab-work" aria-controls="pelican-panel-work" aria-selected={detailMode === "work" || detailMode === "screenshot"} onClick={() => selectMode("work")}><Monitor aria-hidden="true" /><span>作品</span></button>
            <button type="button" role="tab" id="pelican-tab-code" aria-controls="pelican-panel-code" aria-selected={detailMode === "code"} onClick={() => selectMode("code")}><Code2 aria-hidden="true" /><span>代码</span></button>
            <button type="button" role="tab" id="pelican-tab-prompt" aria-controls="pelican-panel-prompt" aria-selected={detailMode === "prompt"} onClick={() => selectMode("prompt")}><FileText aria-hidden="true" /><span>提示词</span></button>
          </div>
        )}
      </dialog>
    </section>
  );
}

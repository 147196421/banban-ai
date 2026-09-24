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
  title?: string;
  svgFormat?: boolean;
};

function svgAspectRatio(html: string) {
  const tag = html.match(/<svg\b[^>]*>/i)?.[0] ?? "";
  const viewBox = /\bviewBox\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
  const numbers = viewBox?.trim().split(/[\s,]+/).map(Number);
  const width = numbers?.length === 4 ? numbers[2] : Number(/\bwidth\s*=\s*["']([\d.]+)(?:px)?["']/i.exec(tag)?.[1]);
  const height = numbers?.length === 4 ? numbers[3] : Number(/\bheight\s*=\s*["']([\d.]+)(?:px)?["']/i.exec(tag)?.[1]);
  const ratio = width / height;
  return Number.isFinite(ratio) && ratio >= 0.25 && ratio <= 5 ? ratio : canvasWidth / canvasHeight;
}

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

export function PelicanPreview({ html, prompt, screenshotUrl, title = "鹈鹕骑行", svgFormat = false }: Props) {
  const [imageFailed, setImageFailed] = useState(false);
  const [detailMode, setDetailMode] = useState<DetailMode>("work");
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");
  const dialog = useRef<HTMLDialogElement>(null);
  const [thumbnailRef, thumbnailWidth] = useElementWidth();
  const [fullRef, fullWidth] = useElementWidth();
  const hasScreenshot = Boolean(screenshotUrl && !imageFailed);
  const previewHeight = svgFormat ? Math.round(canvasWidth / svgAspectRatio(html)) : canvasHeight;
  const previewHtml = svgFormat ? html.replace(/<\/body>/i,
    '<style>html,body{display:block!important;width:100%;height:100%;min-height:0;overflow:hidden}body>svg{display:block;width:100%!important;height:100%!important;max-width:none!important}</style></body>') : html;
  const svgStart = html.search(/<svg\b/i);
  const svgEnd = html.toLowerCase().lastIndexOf("</svg>");
  const sourceCode = svgFormat && svgStart >= 0 && svgEnd > svgStart ? html.slice(svgStart, svgEnd + 6) : html;

  useEffect(() => {
    // 历史记录切换后重试新结果对应的截图。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setImageFailed(false);
  }, [screenshotUrl]);

  const renderCanvas = (width: number, interactive: boolean) => (
    <iframe
      className="pelican-canvas"
      style={{ width: canvasWidth, height: previewHeight, transform: `scale(${width / canvasWidth})` }}
      title={interactive ? `${title}完整预览` : `${title}缩略预览`}
      srcDoc={previewHtml}
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
      await navigator.clipboard.writeText(sourceCode);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("error");
    }
    window.setTimeout(() => setCopyStatus("idle"), 2500);
  };

  return (
    <section className="pelican-preview" aria-label={`${title}浏览器预览`}>
      <div className="preview-chrome">
        <span className="preview-lights" aria-hidden="true"><i /><i /><i /></span>
        <span className="preview-address">模型生成作品</span>
        <button type="button" className="preview-expand" onClick={open} disabled={!hasScreenshot && !html}>
          <ArrowUpRight aria-hidden="true" />查看完整作品
        </button>
      </div>
      {html || hasScreenshot ? (
        <div className="preview-surface" ref={thumbnailRef} style={{ aspectRatio: `${canvasWidth} / ${previewHeight}` }}>
          {html && thumbnailWidth > 0 ? (
            <div className="pelican-canvas-wrapper" aria-hidden="true">{renderCanvas(thumbnailWidth, false)}</div>
          ) : hasScreenshot ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={screenshotUrl} alt={`${title}作品预览`} loading="lazy" onError={() => setImageFailed(true)} />
          ) : null}
          <button type="button" className="preview-surface-open" onClick={open} aria-label={`查看完整${title}作品`} />
        </div>
      ) : (
        <div className="preview-missing"><Braces aria-hidden="true" /><strong>暂无可预览作品</strong></div>
      )}
      <dialog className="pelican-dialog" ref={dialog} aria-label={`${title}作品完整预览`}>
        <div className="pelican-dialog-head">
          <strong>{title}</strong>
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
              <p>{svgFormat ? "本次模型生成的 SVG，作品预览使用了同一份内容。" : "本次模型返回的完整 HTML，与作品预览使用同一份内容。"}</p>
              <pre><code>{sourceCode}</code></pre>
            </div>
          ) : detailMode === "prompt" && html ? (
            <div className="pelican-prompt" role="tabpanel" id="pelican-panel-prompt" aria-labelledby="pelican-tab-prompt">
              <p>{prompt || (title === "鹈鹕骑行" ? fixedPromptSummary : "本次未保存提示词")}</p>
              <small>{title === "鹈鹕骑行" ? prompt ? "本次接口返回的测试提示词" : "标准固定测试题目 · 本次接口结果未单独返回提示词" : "本次输入的提示词"}</small>
            </div>
          ) : detailMode === "screenshot" && hasScreenshot ? (
            <div className="pelican-screenshot-panel" role="tabpanel" id="pelican-panel-work" aria-labelledby="pelican-tab-work">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={screenshotUrl} alt="鹈鹕骑行作品完整浏览器截图" onError={() => setImageFailed(true)} />
            </div>
          ) : html && fullWidth > 0 ? (
            <div className="pelican-full-canvas" role="tabpanel" id="pelican-panel-work" aria-labelledby="pelican-tab-work" style={{ height: previewHeight * fullWidth / canvasWidth }}>
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

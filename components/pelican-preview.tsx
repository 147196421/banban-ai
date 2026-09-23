"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, Braces, X } from "lucide-react";

const canvasWidth = 1280;
const canvasHeight = 960;

type Props = {
  html: string;
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

export function PelicanPreview({ html, screenshotUrl, screenshotError }: Props) {
  const [imageFailed, setImageFailed] = useState(false);
  const [detailMode, setDetailMode] = useState<"work" | "screenshot">("work");
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
          <strong>鹈鹕骑行 · 作品预览</strong>
          <div className="pelican-dialog-actions">
            {html && hasScreenshot && (
              <div className="pelican-dialog-tabs" role="group" aria-label="预览方式">
                <button type="button" aria-pressed={detailMode === "work"} onClick={() => setDetailMode("work")}>作品</button>
                <button type="button" aria-pressed={detailMode === "screenshot"} onClick={() => setDetailMode("screenshot")}>截图</button>
              </div>
            )}
            <button type="button" aria-label="关闭作品预览" onClick={() => dialog.current?.close()}><X aria-hidden="true" /></button>
          </div>
        </div>
        <div className="pelican-dialog-body" ref={fullRef}>
          {hasScreenshot && (detailMode === "screenshot" || !html) ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={screenshotUrl} alt="鹈鹕骑行作品完整浏览器截图" onError={() => setImageFailed(true)} />
          ) : html && fullWidth > 0 ? (
            <div className="pelican-full-canvas" style={{ height: canvasHeight * fullWidth / canvasWidth }}>
              {renderCanvas(fullWidth, true)}
            </div>
          ) : null}
        </div>
      </dialog>
    </section>
  );
}

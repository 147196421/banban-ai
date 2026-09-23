import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "办办AI｜GPT接口能力检测",
  description: "读取接口开放的 GPT 模型，使用固定推理题和单页动画题检测输出表现。",
  icons: {
    icon: "/brand-logo-v1.png",
    shortcut: "/brand-logo-v1.png",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <head><link rel="preload" href="/brand-logo-v1.png" as="image" type="image/png" /></head>
      <body>{children}</body>
    </html>
  );
}

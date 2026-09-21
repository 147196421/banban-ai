import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "办办AI｜GPT接口能力检测",
  description: "读取接口开放的 GPT 模型，使用固定推理题和单页动画题检测输出表现。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}

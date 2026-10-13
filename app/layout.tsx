import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AS Atlas · 全球网络拓扑",
  description: "探索全球 AS 聚合拓扑，比较两个 IP 的 BGP 观测路径。",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">
        <a className="skip-link" href="#main-content">跳至主要内容</a>
        {children}
      </body>
    </html>
  );
}

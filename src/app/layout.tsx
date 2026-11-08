import type { Metadata } from 'next';
import './globals.css';

// App Router 要求根 layout 提供 <html> 与 <body>；缺了它每个页面都会抛
// "Missing <html> and <body> tags in the root layout" 运行时错误。
export const metadata: Metadata = {
  title: 'LyMatrix TEF',
  description: 'LyMatrix Trusted Execution Framework — AI Agent 的确定性执行边界',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}

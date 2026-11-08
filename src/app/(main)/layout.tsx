// =============================================================================
// Layout for (main) route group - includes Header
// =============================================================================

import Header from '@/components/Header';

export default function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <main className="max-w-7xl mx-auto px-4 py-6">
        {children}
      </main>
      {/*
        这里原本挂着 <ConfirmationDialog userId="demo-user" />：它读遗留的
        confirmation_requests 表、用硬编码 userId、且不经过令牌协议。
        TEF 的人工确认已经内嵌在 chat 页的确认卡片里（展示服务端 diff + 一次性令牌），
        所以把这个全局面板摘掉，避免演示时出现两套互相矛盾的确认入口。
        ConfirmationDialog 组件与 /api/confirmations 路由属于 §7.5 步骤 8 的清理范围。
      */}
    </div>
  );
}

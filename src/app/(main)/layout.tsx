// =============================================================================
// Layout for (main) route group - includes Header
// =============================================================================

import Header from '@/components/Header';
import { ConfirmationDialog } from '@/components/ConfirmationDialog';

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
      {/* Use a placeholder userId for now - will be replaced with real auth */}
      <ConfirmationDialog userId="demo-user" />
    </div>
  );
}

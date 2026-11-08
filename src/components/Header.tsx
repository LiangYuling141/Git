// =============================================================================
// Header - Main navigation
// =============================================================================

'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

const NAV_ITEMS = [
  { href: '/', label: '仪表盘' },
  { href: '/customers', label: '客户' },
  { href: '/orders', label: '订单' },
  { href: '/chat', label: 'AI 助手' },
  { href: '/whitelist', label: '白名单' },
  { href: '/audit', label: '审计日志' },
];

export default function Header() {
  const pathname = usePathname();
  const router = useRouter();

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
  }

  return (
    <header className="bg-white border-b border-gray-200">
      <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <Link href="/" className="text-lg font-semibold text-gray-900">
            LyMatrix TEF
          </Link>
          <nav className="flex items-center gap-4">
            {NAV_ITEMS.map((item) => {
              const active = item.href === '/'
                ? pathname === '/'
                : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`text-sm ${
                    active ? 'text-blue-600 font-medium' : 'text-gray-600 hover:text-gray-900'
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>
        <button
          type="button"
          onClick={handleLogout}
          className="text-sm text-gray-600 hover:text-gray-900"
        >
          退出登录
        </button>
      </div>
    </header>
  );
}

// src/proxy.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

const PUBLIC_PATHS = ['/api/auth/login', '/api/auth/logout'];

// 内部网关不使用会话 Cookie：路由内部用 Bearer 服务令牌鉴权
// （src/lib/internal-auth.ts）。必须在会话检查前放行，否则服务令牌请求
// 永远到不了路由，跨服务网关会被统一拦成 401。
const INTERNAL_PATHS = ['/api/internal'];

function matchesPath(pathname: string, paths: readonly string[]): boolean {
  return paths.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Allow public paths
  if (matchesPath(pathname, PUBLIC_PATHS)) {
    return NextResponse.next();
  }

  // Allow internal service-to-service paths; the route authenticates with a
  // Bearer service token instead of a session cookie.
  if (matchesPath(pathname, INTERNAL_PATHS)) {
    return NextResponse.next();
  }

  // Allow non-API paths
  if (!pathname.startsWith('/api/')) {
    return NextResponse.next();
  }

  // Check session cookie
  const sessionId = req.cookies.get('sessionId')?.value;

  if (!sessionId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: { user: true },
    });

    if (!session || (session.expiresAt && session.expiresAt < new Date())) {
      return NextResponse.json({ error: 'Session expired' }, { status: 401 });
    }

    // Add user to request headers for downstream use
    const requestHeaders = new Headers(req.headers);
    requestHeaders.set('x-user-id', session.userId);
    requestHeaders.set('x-user-email', session.user.email || '');

    return NextResponse.next({
      request: { headers: requestHeaders },
    });
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}

export const config = {
  matcher: '/api/:path*',
};
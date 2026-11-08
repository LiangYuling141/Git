// src/proxy.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

const PUBLIC_PATHS = ['/api/auth/login', '/api/auth/logout'];

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Allow public paths
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
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
// src/app/api/audit/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const userId = searchParams.get('userId');
  const entity = searchParams.get('entity');
  const limit = parseInt(searchParams.get('limit') || '100');

  const where: Record<string, unknown> = {};
  if (userId) where.userId = userId;
  if (entity) where.entity = entity;

  const logs = await prisma.auditLog.findMany({
    where,
    orderBy: { timestamp: 'desc' },
    take: Math.min(limit, 500), // Cap at 500
  });

  // Mask sensitive data in before/after fields
  const masked = logs.map(log => ({
    ...log,
    before: maskSensitiveData(log.before),
    after: maskSensitiveData(log.after),
  }));

  return NextResponse.json(masked);
}

function maskSensitiveData(data: unknown): unknown {
  if (!data) return data;
  if (typeof data !== 'object') return data;

  const masked = { ...(data as Record<string, unknown>) };
  const sensitiveFields = ['password', 'token', 'secret', 'creditCard'];

  for (const field of sensitiveFields) {
    if (field in masked && masked[field]) {
      masked[field] = '***MASKED***';
    }
  }

  return masked;
}
// =============================================================================
// System Logs API Route
// =============================================================================

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { LogLevel, LogCategory } from '@/lib/logger';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  const category = searchParams.get('category');
  const level = searchParams.get('level');
  const userId = searchParams.get('userId');
  const component = searchParams.get('component');
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');
  const limit = parseInt(searchParams.get('limit') || '100');

  const where: Record<string, unknown> = {};

  if (category) {
    where.category = category;
  }

  if (level) {
    where.level = level.toUpperCase();
  }

  if (userId) {
    where.userId = userId;
  }

  if (component) {
    where.component = component;
  }

  if (startDate || endDate) {
    where.timestamp = {};
    if (startDate) {
      (where.timestamp as Record<string, Date>).gte = new Date(startDate);
    }
    if (endDate) {
      (where.timestamp as Record<string, Date>).lte = new Date(endDate);
    }
  }

  try {
    const logs = await prisma.systemLog.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      take: Math.min(limit, 500),
    });

    return NextResponse.json(logs);
  } catch (error) {
    console.error('Failed to fetch system logs:', error);
    return NextResponse.json(
      { error: 'Failed to fetch system logs' },
      { status: 500 }
    );
  }
}

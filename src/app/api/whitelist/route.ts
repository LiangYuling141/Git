// src/app/api/whitelist/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET(req: NextRequest) {
  const entries = await prisma.whitelistEntry.findMany({
    orderBy: { enteredAt: 'desc' },
    include: { user: { select: { userName: true, email: true } } },
  });
  return NextResponse.json(entries);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { userId, level, reason } = body;

  if (!userId || !level) {
    return NextResponse.json({ error: 'userId and level are required' }, { status: 400 });
  }

  const validLevels = ['none', 'WL1', 'WL2', 'WL3'];
  if (!validLevels.includes(level)) {
    return NextResponse.json({ error: `level must be one of: ${validLevels.join(', ')}` }, { status: 400 });
  }

  try {
    const entry = await prisma.whitelistEntry.upsert({
      where: { userId },
      create: {
        userId,
        level: level as 'none' | 'WL1' | 'WL2' | 'WL3',
        passedRate: 0,
        monthlyTransaction: 0,
      },
      update: {
        level: level as 'none' | 'WL1' | 'WL2' | 'WL3',
      },
    });
    return NextResponse.json(entry, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update whitelist';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const userId = searchParams.get('userId');

  if (!userId) {
    return NextResponse.json({ error: 'userId is required' }, { status: 400 });
  }

  try {
    await prisma.whitelistEntry.delete({ where: { userId } });
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete whitelist entry';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
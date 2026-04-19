import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { $Enums } from '@/generated/prisma';

// GET: list pending confirmation requests for a user
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const userId = searchParams.get('userId');
  const statusParam = searchParams.get('status') || 'pending';

  if (!userId) {
    return NextResponse.json({ error: 'userId is required' }, { status: 400 });
  }

  const confirmations = await prisma.confirmationRequest.findMany({
    where: { userId, status: statusParam as $Enums.ConfirmationStatus },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });

  // Parse operation JSON for each
  const parsed = confirmations.map(c => ({
    ...c,
    operation: typeof c.operation === 'string' ? JSON.parse(c.operation) : c.operation,
  }));

  return NextResponse.json(parsed);
}

// POST: approve or reject a confirmation
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { id, action, approverId } = body;

  if (!id || !action) {
    return NextResponse.json({ error: 'id and action are required' }, { status: 400 });
  }

  try {
    if (action === 'approve') {
      const updated = await prisma.confirmationRequest.update({
        where: { id },
        data: {
          status: 'approved',
          approvedAt: new Date(),
          approverId,
        },
      });
      return NextResponse.json(updated);
    } else if (action === 'reject') {
      const updated = await prisma.confirmationRequest.update({
        where: { id },
        data: {
          status: 'rejected',
          rejectedAt: new Date(),
        },
      });
      return NextResponse.json(updated);
    } else {
      return NextResponse.json({ error: 'action must be approve or reject' }, { status: 400 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update confirmation';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
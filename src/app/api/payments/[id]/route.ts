// src/app/api/payments/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const payment = await prisma.payment.findUnique({
    where: { id },
    include: { order: true },
  });
  if (!payment) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(payment);
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();

  const validMethods = ['cash', 'transfer', 'credit', 'wechat', 'alipay'];
  const validStatuses = ['pending', 'completed', 'failed', 'refunded'];

  if (body.method && !validMethods.includes(body.method)) {
    return NextResponse.json({ error: `method must be one of: ${validMethods.join(', ')}` }, { status: 400 });
  }
  if (body.status && !validStatuses.includes(body.status)) {
    return NextResponse.json({ error: `status must be one of: ${validStatuses.join(', ')}` }, { status: 400 });
  }

  try {
    const payment = await prisma.payment.update({
      where: { id },
      data: {
        amount: body.amount !== undefined ? Number(body.amount) : undefined,
        method: body.method,
        remark: body.remark,
        status: body.status,
      },
      include: { order: true },
    });
    return NextResponse.json(payment);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update payment';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    // Soft delete - mark as refunded
    await prisma.payment.update({
      where: { id },
      data: { status: 'refunded' },
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to refund payment';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
// src/app/api/payments/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  const orderId = searchParams.get('orderId');
  const status = searchParams.get('status');

  if (id) {
    const payment = await prisma.payment.findUnique({
      where: { id },
      include: { order: true },
    });
    if (!payment) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(payment);
  }

  const where: Record<string, unknown> = {};
  if (orderId) where.orderId = orderId;
  if (status) where.status = status;

  const payments = await prisma.payment.findMany({
    where,
    take: 100,
    orderBy: { createdAt: 'desc' },
    include: { order: true },
  });
  return NextResponse.json(payments);
}

export async function POST(req: NextRequest) {
  const body = await req.json();

  // Validate required fields
  if (!body.orderId || !body.amount || !body.method) {
    return NextResponse.json({ error: 'orderId, amount, and method are required' }, { status: 400 });
  }

  // Verify order exists
  const order = await prisma.order.findUnique({ where: { id: body.orderId } });
  if (!order) {
    return NextResponse.json({ error: 'Order not found' }, { status: 404 });
  }

  // Validate method
  const validMethods = ['cash', 'transfer', 'credit', 'wechat', 'alipay'];
  if (!validMethods.includes(body.method)) {
    return NextResponse.json({ error: `method must be one of: ${validMethods.join(', ')}` }, { status: 400 });
  }

  try {
    const payment = await prisma.payment.create({
      data: {
        orderId: body.orderId,
        amount: Number(body.amount),
        method: body.method,
        remark: body.remark,
        status: body.status || 'pending',
      },
      include: { order: true },
    });
    return NextResponse.json(payment, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create payment';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
// src/app/api/orders/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  const status = searchParams.get('status');
  const customerId = searchParams.get('customerId');

  if (id) {
    const order = await prisma.order.findUnique({
      where: { id },
      include: { customer: true, payments: true },
    });
    if (!order) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(order);
  }

  const where: Record<string, unknown> = {};
  if (status) where.status = status;
  if (customerId) where.customerId = customerId;

  const orders = await prisma.order.findMany({
    where,
    take: 100,
    orderBy: { createdAt: 'desc' },
    include: { customer: true },
  });
  return NextResponse.json(orders);
}

export async function POST(req: NextRequest) {
  const body = await req.json();

  // Validate required fields
  if (!body.customerId || !body.items || !body.totalAmount) {
    return NextResponse.json({ error: 'customerId, items, and totalAmount are required' }, { status: 400 });
  }

  // Verify customer exists
  const customer = await prisma.customer.findUnique({ where: { id: body.customerId } });
  if (!customer) {
    return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
  }

  // Generate order number
  const orderNo = body.orderNo || `ORD-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  try {
    const order = await prisma.order.create({
      data: {
        customerId: body.customerId,
        orderNo,
        items: body.items as object,
        totalAmount: Number(body.totalAmount),
        discount: body.discount !== undefined ? Number(body.discount) : undefined,
        remark: body.remark,
        status: body.status || 'pending',
      },
      include: { customer: true },
    });

    // Update customer's last transaction date
    await prisma.customer.update({
      where: { id: body.customerId },
      data: { lastTransactionDate: new Date() },
    });

    return NextResponse.json(order, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create order';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
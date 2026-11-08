// src/app/api/orders/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const order = await prisma.order.findUnique({
    where: { id },
    include: { customer: true, payments: true },
  });
  if (!order) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(order);
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();

  try {
    const order = await prisma.order.update({
      where: { id },
      data: {
        items: body.items !== undefined ? (body.items as object) : undefined,
        totalAmount: body.totalAmount !== undefined ? Number(body.totalAmount) : undefined,
        discount: body.discount !== undefined ? Number(body.discount) : undefined,
        remark: body.remark,
        status: body.status,
      },
      include: { customer: true },
    });
    return NextResponse.json(order);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update order';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    // Soft delete - mark as cancelled
    await prisma.order.update({
      where: { id },
      data: { status: 'cancelled' },
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to cancel order';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
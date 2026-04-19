// src/app/api/customers/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const customer = await prisma.customer.findUnique({ where: { id } });
  if (!customer) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(customer);
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();

  try {
    const customer = await prisma.customer.update({
      where: { id },
      data: {
        name: body.name,
        phone: body.phone,
        email: body.email,
        address: body.address,
        taxId: body.taxId,
        creditLimit: body.creditLimit !== undefined ? Number(body.creditLimit) : undefined,
        creditLine: body.creditLine !== undefined ? Number(body.creditLine) : undefined,
        isHighRisk: body.isHighRisk,
        monthlyTransaction: body.monthlyTransaction !== undefined ? Number(body.monthlyTransaction) : undefined,
      },
    });
    return NextResponse.json(customer);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update customer';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    await prisma.customer.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete customer';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

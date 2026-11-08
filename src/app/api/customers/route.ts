// src/app/api/customers/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  const name = searchParams.get('name');

  if (id) {
    const customer = await prisma.customer.findUnique({ where: { id } });
    if (!customer) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(customer);
  }

  if (name) {
    const customers = await prisma.customer.findMany({
      where: { name: { contains: name } },
      take: 100,
    });
    return NextResponse.json(customers);
  }

  const customers = await prisma.customer.findMany({ take: 100, orderBy: { createdAt: 'desc' } });
  return NextResponse.json(customers);
}

export async function POST(req: NextRequest) {
  const body = await req.json();

  // Validate required fields
  if (!body.name || !body.phone) {
    return NextResponse.json({ error: 'name and phone are required' }, { status: 400 });
  }

  try {
    const customer = await prisma.customer.create({
      data: {
        name: body.name,
        phone: body.phone,
        email: body.email,
        address: body.address,
        taxId: body.taxId,
        creditLimit: Number(body.creditLimit || 0),
        creditLine: Number(body.creditLine || 0),
      },
    });
    return NextResponse.json(customer, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create customer';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

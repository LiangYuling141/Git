// src/app/api/onboarding/[customerId]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { auditLogger } from '@/audit/AuditLogger';

export async function GET(req: NextRequest, { params }: { params: Promise<{ customerId: string }> }) {
  const { customerId } = await params;

  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: {
      id: true,
      name: true,
      onboardingStatus: true,
      onboardingData: true,
    },
  });

  if (!customer) {
    return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
  }

  return NextResponse.json({
    customerId: customer.id,
    customerName: customer.name,
    onboardingStatus: customer.onboardingStatus,
    onboardingData: customer.onboardingData,
  });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ customerId: string }> }) {
  const { customerId } = await params;
  const body = await req.json();

  // Get current customer state for audit
  const currentCustomer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: {
      onboardingStatus: true,
      onboardingData: true,
    },
  });

  if (!currentCustomer) {
    return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
  }

  // Validate status transition
  const validStatuses = ['pending', 'in_progress', 'completed'];
  if (body.onboardingStatus && !validStatuses.includes(body.onboardingStatus)) {
    return NextResponse.json(
      { error: 'Invalid onboardingStatus. Must be one of: pending, in_progress, completed' },
      { status: 400 }
    );
  }

  try {
    const updateData: Record<string, unknown> = {};

    if (body.onboardingStatus) {
      updateData.onboardingStatus = body.onboardingStatus;

      // Mark completion time if completing
      if (body.onboardingStatus === 'completed' && currentCustomer.onboardingData) {
        updateData.onboardingData = {
          ...(currentCustomer.onboardingData as Record<string, unknown>),
          completedAt: new Date(),
        };
      }
    }

    if (body.onboardingData) {
      updateData.onboardingData = {
        ...(currentCustomer.onboardingData as Record<string, unknown>),
        ...body.onboardingData,
      };
    }

    const customer = await prisma.customer.update({
      where: { id: customerId },
      data: updateData,
    });

    // Log onboarding status change to audit
    const operation = body.onboardingStatus === 'completed'
      ? 'ONBOARDING_COMPLETED'
      : 'ONBOARDING_UPDATED';

    await auditLogger.log({
      id: crypto.randomUUID(),
      timestamp: new Date(),
      userId: body.userId || 'system',
      operation,
      entity: 'Customer',
      entityId: customerId,
      before: {
        onboardingStatus: currentCustomer.onboardingStatus,
        onboardingData: currentCustomer.onboardingData,
      },
      after: {
        onboardingStatus: customer.onboardingStatus,
        onboardingData: customer.onboardingData,
      },
      ip: req.headers.get('x-forwarded-for') || '',
      userAgent: req.headers.get('user-agent') || '',
      result: 'success',
    });

    return NextResponse.json({
      customerId: customer.id,
      onboardingStatus: customer.onboardingStatus,
      onboardingData: customer.onboardingData,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update onboarding';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
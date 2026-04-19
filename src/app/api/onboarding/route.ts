// src/app/api/onboarding/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { auditLogger } from '@/audit/AuditLogger';

export async function POST(req: NextRequest) {
  const body = await req.json();

  // Validate required fields
  if (!body.customerId) {
    return NextResponse.json({ error: 'customerId is required' }, { status: 400 });
  }

  // Validate onboarding data fields
  const { enterpriseType, monthlyOrderVolume, mainMarket, customerSource } = body.onboardingData || {};
  if (!enterpriseType || !monthlyOrderVolume || !mainMarket || !customerSource) {
    return NextResponse.json(
      { error: 'All onboarding fields are required: enterpriseType, monthlyOrderVolume, mainMarket, customerSource' },
      { status: 400 }
    );
  }

  try {
    // Update customer with onboarding data and status
    const customer = await prisma.customer.update({
      where: { id: body.customerId },
      data: {
        onboardingStatus: 'in_progress',
        onboardingData: {
          enterpriseType,
          monthlyOrderVolume,
          mainMarket,
          customerSource,
          startedAt: new Date(),
        },
      },
    });

    // Log onboarding start to audit
    await auditLogger.log({
      id: crypto.randomUUID(),
      timestamp: new Date(),
      userId: body.userId || 'system',
      operation: 'ONBOARDING_START',
      entity: 'Customer',
      entityId: body.customerId,
      before: null,
      after: customer.onboardingData as Record<string, unknown>,
      ip: req.headers.get('x-forwarded-for') || '',
      userAgent: req.headers.get('user-agent') || '',
      result: 'success',
    });

    return NextResponse.json({
      customerId: customer.id,
      onboardingStatus: customer.onboardingStatus,
      onboardingData: customer.onboardingData,
    }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to start onboarding';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
// =============================================================================
// Confirmation Workflow - Human-in-the-loop confirmation
// =============================================================================

import type { ConfirmationRequest, Operation, RiskLevel, Session } from '@/types';
import { prisma } from '@/lib/prisma';

export class ConfirmationWorkflow {
  async createRequest(
    operation: Operation,
    riskLevel: RiskLevel,
    session: Session
  ): Promise<ConfirmationRequest> {
    const request = await prisma.confirmationRequest.create({
      data: {
        operation: JSON.stringify(operation),
        riskLevel,
        userId: session.userId,
        status: 'pending',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
      },
    });

    return {
      id: request.id,
      operation,
      riskLevel: request.riskLevel as RiskLevel,
      userId: request.userId,
      status: request.status as 'pending' | 'approved' | 'rejected' | 'expired',
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
      approvedAt: request.approvedAt ?? undefined,
      rejectedAt: request.rejectedAt ?? undefined,
      approverId: request.approverId ?? undefined,
    };
  }

  async approve(id: string, approverId: string): Promise<boolean> {
    const request = await prisma.confirmationRequest.findUnique({ where: { id } });
    if (!request || request.status !== 'pending') {
      return false;
    }

    if (new Date() > request.expiresAt) {
      await prisma.confirmationRequest.update({
        where: { id },
        data: { status: 'expired' },
      });
      return false;
    }

    await prisma.confirmationRequest.update({
      where: { id },
      data: {
        status: 'approved',
        approvedAt: new Date(),
        approverId,
      },
    });
    return true;
  }

  async reject(id: string): Promise<boolean> {
    const request = await prisma.confirmationRequest.findUnique({ where: { id } });
    if (!request || request.status !== 'pending') {
      return false;
    }

    await prisma.confirmationRequest.update({
      where: { id },
      data: {
        status: 'rejected',
        rejectedAt: new Date(),
      },
    });
    return true;
  }

  async getRequest(id: string): Promise<ConfirmationRequest | null> {
    const request = await prisma.confirmationRequest.findUnique({ where: { id } });
    if (!request) {
      return null;
    }

    const op = typeof request.operation === 'string'
      ? JSON.parse(request.operation)
      : request.operation;

    return {
      id: request.id,
      operation: op as Operation,
      riskLevel: request.riskLevel as RiskLevel,
      userId: request.userId,
      status: request.status as 'pending' | 'approved' | 'rejected' | 'expired',
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
      approvedAt: request.approvedAt ?? undefined,
      rejectedAt: request.rejectedAt ?? undefined,
      approverId: request.approverId ?? undefined,
    };
  }

  async getPendingRequests(userId: string): Promise<ConfirmationRequest[]> {
    const requests = await prisma.confirmationRequest.findMany({
      where: { userId, status: 'pending' },
    });

    return requests.map((r) => {
      const op = typeof r.operation === 'string'
        ? JSON.parse(r.operation)
        : r.operation;

      return {
        id: r.id,
        operation: op as Operation,
        riskLevel: r.riskLevel as RiskLevel,
        userId: r.userId,
        status: r.status as 'pending' | 'approved' | 'rejected' | 'expired',
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        approvedAt: r.approvedAt ?? undefined,
        rejectedAt: r.rejectedAt ?? undefined,
        approverId: r.approverId ?? undefined,
      };
    });
  }
}

export const confirmationWorkflow = new ConfirmationWorkflow();
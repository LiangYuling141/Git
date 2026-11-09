export {
  createTefServer,
  approveOutOfBand,
  visibleToolsFor,
  type TefServerOptions,
  type VerticalToolContext,
  type VerticalToolRegistrar,
} from './server';
export { connectTefClient, type TefClientSession, type TefServerFactory } from './transport';
export { buildExecContext, type Principal, type ExecContextOptions } from './principal';
export { envelopeToToolResult, errorToEnvelope, ok, fail, blocked, conflict, needsConfirmation } from './envelope';
export { auditTrace, policyGet } from './tools/audit';
export { confirmationApprove, confirmationReject } from './tools/confirmation';
export { previewContract, executeContract, type ContractWriteOptions, type AdapterFactory } from './tools/contract';
export { previewStore } from './preview-store';
export { tokenStore, loadTokenSecret } from './token';
export { auditChain } from './audit-chain';
export { withTenantScope, withTenantRead } from './tenant-scope';
export { toolsForClient, canCallTool, resolveTenantContext, toThresholdRecord } from './tenant';
export type { PrismaTx } from './prisma';

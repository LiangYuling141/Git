export { createTefServer, approveOutOfBand, visibleToolsFor, type TefServerOptions } from './server';
export { connectTefClient, type TefClientSession } from './transport';
export { buildExecContext, type Principal, type ExecContextOptions } from './principal';
export {
  envelopeToToolResult,
  errorToEnvelope,
  ok,
  fail,
  blocked,
  conflict,
  needsConfirmation,
} from './envelope';
export {
  creditGet,
  customerGet,
  customerSearch,
  inventoryCheck,
  maskPhone,
  orderGet,
} from './tools/query';
export {
  orderExecuteCompensate,
  orderExecuteCreate,
  orderPreviewCompensate,
  orderPreviewCreate,
} from './tools/order';
export { confirmationApprove, confirmationReject } from './tools/confirmation';
export { auditTrace, policyGet } from './tools/audit';

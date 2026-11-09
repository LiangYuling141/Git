export { createCrmErpServer, connectCrmErpClient } from './server';
export { createPrismaCrmGateway } from './gateway/prisma-gateway';
export {
  CRM_QUERY,
  type CrmBusinessGateway,
  type CrmQueryOperation,
  type CreditRecord,
  type CustomerRecord,
  type CustomerSearchInput,
  type OrderRecord,
  type PaymentRecord,
  type ProductRecord,
} from './gateway/types';
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
export { createCreditOrderAdapters, registerCreditOrderContracts } from './contracts/credit-order';

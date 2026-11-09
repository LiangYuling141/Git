import { z } from 'zod';
import { CRM_QUERY } from '@lymtrix/vertical-crm-erp';

/**
 * 内部 query 网关的按 operation 参数白名单。
 *
 * 路由不能把任意 params 直接透传给垂直网关：Prisma 会静默忽略 `undefined`
 * 过滤条件，缺少 customerId 的 customer.get 将返回本租户任意客户。因此每个
 * operation 都必须在进入事务前通过显式 schema 校验，未知 operation 直接拒绝。
 */

const customerSearchParams = z
  .object({
    name: z.string().min(1).optional(),
    phone: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .refine((params) => Boolean(params.name || params.phone), {
    message: 'customer search requires name or phone',
  });

const customerIdParams = z.object({
  customerId: z.string().min(1),
});

const orderLookupParams = z
  .object({
    orderId: z.string().min(1).optional(),
    orderNo: z.string().min(1).optional(),
  })
  .refine((params) => Boolean(params.orderId || params.orderNo), {
    message: 'order.get requires orderId or orderNo',
  });

const operationParams = {
  [CRM_QUERY.customerSearch]: customerSearchParams,
  [CRM_QUERY.customerGet]: customerIdParams,
  [CRM_QUERY.creditGet]: customerIdParams,
  [CRM_QUERY.productsGet]: z.object({
    skus: z.array(z.string().min(1)).min(1),
  }),
  [CRM_QUERY.productsSearch]: z.object({
    term: z.string().min(1).optional(),
  }),
  [CRM_QUERY.orderGet]: orderLookupParams,
} as const;

export type InternalQueryOperation = keyof typeof operationParams;

// 判别字段使用字符串字面量：项目 tsconfig 未开启 strictNullChecks，
// 布尔字面量判别联合在该配置下无法收窄（TS2339）。
export type ParsedInternalQuery =
  | { status: 'ok'; operation: InternalQueryOperation; params: Record<string, unknown> }
  | { status: 'invalid'; message: string };

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

/**
 * 校验 operation 是否在白名单内，并返回剥离未知键后的参数。
 * 失败信息只包含字段路径与 zod 约束，不包含堆栈或内部实现。
 */
export function parseInternalQuery(operation: string, params: unknown): ParsedInternalQuery {
  if (!Object.hasOwn(operationParams, operation)) {
    return { status: 'invalid', message: `unknown operation: ${operation}` };
  }

  const key = operation as InternalQueryOperation;
  const parsed = operationParams[key].safeParse(params);
  if (!parsed.success) {
    return { status: 'invalid', message: formatIssues(parsed.error) };
  }

  return { status: 'ok', operation: key, params: parsed.data as Record<string, unknown> };
}

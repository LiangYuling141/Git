import {
  EffectsExecutionUnknownError,
  TefError,
  type EffectsExecuteRequest,
  type EffectsExecuteResult,
  type ErrorCode,
} from '@lymtrix/tef-core';
import type {
  CrmBusinessGateway,
  CustomerRecord,
  CreditRecord,
  OrderRecord,
  ProductRecord,
} from './types';
import { CRM_QUERY } from './types';

/**
 * 跨服务业务网关：把垂直查询翻译成 CRM 内部 HTTP 调用。
 *
 * 业务 MCP 不持有业务库凭据，只持有服务令牌；所有查询都显式带 tenantId，
 * 并在发请求前与本网关闭包绑定的租户比对，防止一次参数错误变成跨租户读取。
 */

export interface HttpCrmGatewayOptions {
  baseUrl: string;
  serviceToken: string;
  tenantId: string;
}

/** 内部网关与 CRM 同机房，10 秒足够；避免 CRM 挂起时调用方无限等待。 */
const REQUEST_TIMEOUT_MS = 10_000;

/** 内部网关会返回的错误码；其余一律按 INTERNAL 处理，避免透传未知语义。 */
const MAPPED_ERROR_CODES: ReadonlySet<string> = new Set([
  'VALIDATION_ERROR',
  'PERMISSION_DENIED',
  'NOT_FOUND',
  'CONFLICT',
]);

/**
 * 去掉 `undefined` 与空字符串参数。
 *
 * MCP 查询工具会把缺省字段规范成 `''`（customer.search 的 name/phone、
 * order.get 的 orderId），而内部路由的 zod schema 对业务标识使用 `min(1)`。
 * 原样透传会把“字段缺省”误判成“字段非法”并返回 400。只清理 `undefined`
 * 与 `''`，保留 `0`、`false` 与空数组等合法值。
 */
function sanitizeParams(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== ''),
  );
}

/** 把内部网关的错误响应映射为带稳定错误码的 TefError。 */
function toTefError(payload: unknown, status: number): TefError {
  const body = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const message =
    typeof body.message === 'string' && body.message ? body.message : `CRM gateway error ${status}`;
  const code =
    typeof body.error === 'string' && MAPPED_ERROR_CODES.has(body.error)
      ? (body.error as ErrorCode)
      : 'INTERNAL';
  return new TefError(code, message);
}

interface EffectsErrorDetail {
  code?: string;
  message: string;
}

/** 同时兼容 `{ error: { code, message } }` 与 `{ error, message }` 两种历史形状。 */
function effectsErrorDetail(payload: unknown, status: number): EffectsErrorDetail {
  const body = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const detail =
    body.error && typeof body.error === 'object' ? (body.error as Record<string, unknown>) : {};
  const message =
    typeof detail.message === 'string' && detail.message
      ? detail.message
      : typeof body.message === 'string' && body.message
        ? body.message
        : `CRM effects gateway error ${status}`;
  return {
    code: typeof detail.code === 'string' ? detail.code : typeof body.error === 'string' ? body.error : undefined,
    message,
  };
}

/**
 * effects 路由把执行失败表达为结构化结果而不是 HTTP 异常语义：
 * 调用方需要区分“可重试/可补偿的业务冲突”和“内部错误”。端口类型只允许
 * CONFLICT / INTERNAL 两个错误码，因此 400 校验错误也收敛为 INTERNAL，
 * 服务端 message 仍原样保留，便于定位。
 */
function toEffectsFailure(payload: unknown, status: number): EffectsExecuteResult {
  const detail = effectsErrorDetail(payload, status);
  const code = detail.code === 'CONFLICT' || status === 409 ? 'CONFLICT' : 'INTERNAL';
  return { ok: false, refs: {}, error: { code, message: detail.message } };
}

/**
 * 5xx / EXECUTION_UNKNOWN 表示副作用可能已提交但结果无法确认。
 *
 * 500/502/503/504 都无法证明“请求没有到达执行器”或“事务已回滚”：代理超时、
 * 上游重启、响应丢失都会落在这几个状态码上。按端口约定只能收敛为 unknown，
 * 交给对账用同一幂等键确认，不能映射成 INTERNAL 诱导调用方换 key 重试。
 * 409 是确定性冲突，400 是确定性校验失败，都不在此列。
 */
const UNKNOWN_EXECUTION_HTTP_STATUSES: ReadonlySet<number> = new Set([500, 502, 503, 504]);

export function isEffectsExecutionUnknown(payload: unknown, status: number): boolean {
  return UNKNOWN_EXECUTION_HTTP_STATUSES.has(status) || effectsErrorDetail(payload, status).code === 'EXECUTION_UNKNOWN';
}

/**
 * 2xx 响应必须至少满足 `{ ok: boolean, refs: object }`。
 *
 * 内部网关与业务 MCP 可能由不同版本部署，路由被反向代理接管或误配时
 * 也可能返回任意 200 页面。这里只做端口语义的最小校验，不认识的附加字段
 * （如 replayed）按布尔值透传；结构不符则抛 INTERNAL，避免把垃圾响应当成
 * “副作用已成功”继续执行。
 *
 * 2xx 也可能承载业务失败（`{ ok: false, error }`）：此时必须保留 error 的
 * code/message，否则调用方只看到 `ok: false`，无法区分可补偿的 CONFLICT
 * 与需要人工介入的 INTERNAL。
 */
function parseEffectsResponse(payload: unknown): EffectsExecuteResult {
  const body = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
  const refs = body?.refs;
  if (!body || typeof body.ok !== 'boolean' || !refs || typeof refs !== 'object' || Array.isArray(refs)) {
    throw new TefError('INTERNAL', 'invalid effects response');
  }
  const result: EffectsExecuteResult = {
    ok: body.ok,
    refs: refs as Record<string, Record<string, unknown>>,
  };
  if (typeof body.replayed === 'boolean') result.replayed = body.replayed;
  if (!body.ok) {
    const detail =
      body.error && typeof body.error === 'object' && !Array.isArray(body.error)
        ? (body.error as Record<string, unknown>)
        : {};
    const message =
      typeof detail.message === 'string' && detail.message
        ? detail.message
        : 'CRM effects gateway reported failure';
    result.error = {
      code: detail.code === 'CONFLICT' ? 'CONFLICT' : 'INTERNAL',
      message,
    };
  }
  return result;
}

export function createHttpCrmGateway(options: HttpCrmGatewayOptions): CrmBusinessGateway {
  const { baseUrl, serviceToken, tenantId } = options;
  if (!baseUrl) throw new TefError('INTERNAL', 'TEF_CRM_API_BASE is not configured');
  if (!serviceToken) throw new TefError('INTERNAL', 'TEF_CRM_SERVICE_TOKEN is not configured');
  if (!tenantId) throw new TefError('INTERNAL', 'HttpCrmGateway tenantId is not configured');

  interface RawResponse {
    ok: boolean;
    status: number;
    payload: unknown;
  }

  interface PostOptions {
    /**
     * effects 写入通道：网络错误/超时无法证明副作用未提交，必须抛
     * EffectsExecutionUnknownError 交给对账；查询通道可安全地按 INTERNAL 处理。
     */
    unknownOnTransportFailure?: boolean;
  }

  const post = async (
    path: string,
    body: Record<string, unknown>,
    options: PostOptions = {},
  ): Promise<RawResponse> => {
    let response: Response;
    try {
      response = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${serviceToken}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (options.unknownOnTransportFailure) {
        throw new EffectsExecutionUnknownError(`CRM effects gateway request failed: ${detail}`);
      }
      throw new TefError('INTERNAL', `CRM gateway request failed: ${detail}`);
    }
    const payload = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, payload };
  };

  const call = async <T>(path: string, body: Record<string, unknown>): Promise<T> => {
    const { ok, status, payload } = await post(path, body);
    if (!ok) {
      throw toTefError(payload, status);
    }
    return payload as T;
  };

  const assertTenant = (inputTenant: string): void => {
    if (inputTenant !== tenantId) throw new TefError('PERMISSION_DENIED', 'gateway tenant mismatch');
  };

  const gateway: CrmBusinessGateway = {
    async query<T>(input: { tenantId: string; operation: string; params: Record<string, unknown> }): Promise<T> {
      assertTenant(input.tenantId);
      const result = await call<{ data: T }>('/api/internal/v1/query', {
        tenantId: input.tenantId,
        operation: input.operation,
        params: sanitizeParams(input.params),
      });
      return result.data;
    },
    searchCustomers(input: { tenantId: string; name?: string; phone?: string; limit?: number }) {
      return gateway.query<CustomerRecord[]>({ tenantId: input.tenantId, operation: CRM_QUERY.customerSearch, params: input });
    },
    getCustomer(input: { tenantId: string; customerId: string }) {
      return gateway.query<CustomerRecord | null>({ tenantId: input.tenantId, operation: CRM_QUERY.customerGet, params: input });
    },
    getCredit(input: { tenantId: string; customerId: string }) {
      return gateway.query<CreditRecord | null>({ tenantId: input.tenantId, operation: CRM_QUERY.creditGet, params: input });
    },
    getProducts(input: { tenantId: string; skus: string[] }) {
      return gateway.query<ProductRecord[]>({ tenantId: input.tenantId, operation: CRM_QUERY.productsGet, params: input });
    },
    searchProducts(input: { tenantId: string; term?: string }) {
      return gateway.query<ProductRecord[]>({ tenantId: input.tenantId, operation: CRM_QUERY.productsSearch, params: input });
    },
    getOrder(input: { tenantId: string; orderId?: string; orderNo?: string }) {
      return gateway.query<OrderRecord | null>({ tenantId: input.tenantId, operation: CRM_QUERY.orderGet, params: input });
    },
    async executeEffects(input: EffectsExecuteRequest): Promise<EffectsExecuteResult> {
      // 租户校验必须在网络调用之前：错误的闭包绑定不能变成一次跨租户写入请求。
      assertTenant(input.tenantId);
      const { ok, status, payload } = await post(
        '/api/internal/v1/effects/execute',
        {
          tenantId: input.tenantId,
          idempotencyKey: input.idempotencyKey,
          previewId: input.previewId,
          traceId: input.traceId,
          expectedEvidenceVersion: input.expectedEvidenceVersion,
          effects: input.effects,
        },
        { unknownOnTransportFailure: true },
      );
      if (!ok) {
        if (isEffectsExecutionUnknown(payload, status)) {
          throw new EffectsExecutionUnknownError(effectsErrorDetail(payload, status).message);
        }
        return toEffectsFailure(payload, status);
      }
      return parseEffectsResponse(payload);
    },
  };

  return gateway;
}

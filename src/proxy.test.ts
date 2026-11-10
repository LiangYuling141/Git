import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from './proxy';

// 会话查询必须保持 DB-free：两个用例都在进入数据库之前返回。
// 用 hoisted mock 断言 findUnique 从未被调用；若调用链意外触库会得到明确的
// 失败信息，而不是依赖本地 DATABASE_URL 是否可用。
const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));

vi.mock('@/lib/prisma', () => ({
  prisma: { session: { findUnique } },
}));

describe('proxy', () => {
  it('放行内部网关路径，由路由内的服务令牌鉴权，不检查会话', async () => {
    const response = await proxy(new NextRequest('http://localhost/api/internal/v1/query'));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('无会话 Cookie 的普通 API 请求返回 401', async () => {
    const response = await proxy(new NextRequest('http://localhost/api/customers'));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(findUnique).not.toHaveBeenCalled();
  });
});

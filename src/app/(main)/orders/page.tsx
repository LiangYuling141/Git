'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';

interface Order {
  id: string;
  orderNo: string;
  customerId: string;
  totalAmount: number;
  status: string;
  createdAt: string;
  customer: { id: string; name: string; phone: string };
}

const STATUS_COLORS: Record<string, string> = {
  pending: '#faad14',
  confirmed: '#1890ff',
  shipped: '#52c41a',
  completed: '#52c41a',
  cancelled: '#ff4d4f',
};

const STATUS_LABELS: Record<string, string> = {
  pending: '待确认',
  confirmed: '已确认',
  shipped: '已发货',
  completed: '已完成',
  cancelled: '已取消',
};

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');

  useEffect(() => {
    const url = statusFilter ? `/api/orders?status=${statusFilter}` : '/api/orders';
    fetch(url)
      .then(r => r.json())
      .then(data => {
        setOrders(Array.isArray(data) ? data : []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [statusFilter]);

  return (
    <div style={{ padding: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '24px' }}>
        <h1>订单管理</h1>
        <Link href="/orders/new">
          <button style={{ padding: '8px 16px', background: '#1890ff', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
            + 新建订单
          </button>
        </Link>
      </div>

      <div style={{ marginBottom: '16px', display: 'flex', gap: '8px' }}>
        {['', 'pending', 'confirmed', 'shipped', 'completed', 'cancelled'].map(s => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            style={{
              padding: '4px 12px',
              border: statusFilter === s ? '2px solid #1890ff' : '1px solid #ddd',
              borderRadius: '4px',
              background: statusFilter === s ? '#e6f7ff' : '#fff',
              cursor: 'pointer',
            }}
          >
            {s ? STATUS_LABELS[s] : '全部'}
          </button>
        ))}
      </div>

      {loading ? (
        <p>加载中...</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #eee', textAlign: 'left' }}>
              <th style={{ padding: '12px 8px' }}>订单号</th>
              <th style={{ padding: '12px 8px' }}>客户</th>
              <th style={{ padding: '12px 8px' }}>金额</th>
              <th style={{ padding: '12px 8px' }}>状态</th>
              <th style={{ padding: '12px 8px' }}>创建时间</th>
              <th style={{ padding: '12px 8px' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {orders.map(o => (
              <tr key={o.id} style={{ borderBottom: '1px solid #eee' }}>
                <td style={{ padding: '12px 8px' }}>{o.orderNo}</td>
                <td style={{ padding: '12px 8px' }}>{o.customer?.name || o.customerId}</td>
                <td style={{ padding: '12px 8px' }}>¥{o.totalAmount.toLocaleString()}</td>
                <td style={{ padding: '12px 8px' }}>
                  <span style={{ padding: '2px 8px', borderRadius: '4px', background: STATUS_COLORS[o.status] + '20', color: STATUS_COLORS[o.status] }}>
                    {STATUS_LABELS[o.status] || o.status}
                  </span>
                </td>
                <td style={{ padding: '12px 8px' }}>{new Date(o.createdAt).toLocaleDateString()}</td>
                <td style={{ padding: '12px 8px' }}>
                  <Link href={`/orders/${o.id}`}>
                    <button style={{ padding: '4px 8px', cursor: 'pointer' }}>查看</button>
                  </Link>
                </td>
              </tr>
            ))}
            {orders.length === 0 && (
              <tr><td colSpan={6} style={{ padding: '24px', textAlign: 'center', color: '#999' }}>暂无数据</td></tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
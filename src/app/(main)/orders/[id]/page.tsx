'use client';
import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';

interface Order {
  id: string;
  orderNo: string;
  customerId: string;
  items: Array<{ productId: string; productName: string; quantity: number; price: number; subtotal: number }>;
  totalAmount: number;
  discount?: number;
  remark?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  customer: { id: string; name: string; phone: string };
  payments: Array<{ id: string; amount: number; method: string; status: string; createdAt: string }>;
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

export default function OrderDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    fetch(`/api/orders?id=${id}`)
      .then(r => r.json())
      .then(data => {
        setOrder(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [id]);

  const updateStatus = async (newStatus: string) => {
    setUpdating(true);
    const res = await fetch(`/api/orders/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    });
    if (res.ok) {
      const updated = await res.json();
      setOrder({ ...order!, status: updated.status });
    }
    setUpdating(false);
  };

  if (loading) return <div style={{ padding: '24px' }}>加载中...</div>;
  if (!order) return <div style={{ padding: '24px' }}>订单不存在</div>;

  return (
    <div style={{ padding: '24px', maxWidth: '900px' }}>
      <div style={{ marginBottom: '24px' }}>
        <Link href="/orders" style={{ color: '#1890ff' }}>← 返回订单列表</Link>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <h1>订单 {order.orderNo}</h1>
        <span style={{ padding: '4px 12px', borderRadius: '4px', background: STATUS_COLORS[order.status] + '20', color: STATUS_COLORS[order.status], fontWeight: 500 }}>
          {STATUS_LABELS[order.status] || order.status}
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '24px' }}>
        <div style={{ padding: '16px', background: '#f9f9f9', borderRadius: '8px' }}>
          <div style={{ color: '#999', fontSize: '12px', marginBottom: '4px' }}>客户</div>
          <div style={{ fontWeight: 500 }}>{order.customer?.name || order.customerId}</div>
          <div style={{ color: '#666', fontSize: '14px' }}>{order.customer?.phone}</div>
        </div>
        <div style={{ padding: '16px', background: '#f9f9f9', borderRadius: '8px' }}>
          <div style={{ color: '#999', fontSize: '12px', marginBottom: '4px' }}>下单时间</div>
          <div>{new Date(order.createdAt).toLocaleString()}</div>
        </div>
      </div>

      <h2 style={{ fontSize: '16px', marginBottom: '12px' }}>商品明细</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '24px' }}>
        <thead>
          <tr style={{ borderBottom: '2px solid #eee' }}>
            {['商品名称', '数量', '单价', '小计'].map(h => (
              <th key={h} style={{ padding: '12px 8px', textAlign: 'left', color: '#666' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(order.items || []).map((item, i) => (
            <tr key={i} style={{ borderBottom: '1px solid #eee' }}>
              <td style={{ padding: '12px 8px' }}>{item.productName}</td>
              <td style={{ padding: '12px 8px' }}>{item.quantity}</td>
              <td style={{ padding: '12px 8px' }}>¥{item.price.toLocaleString()}</td>
              <td style={{ padding: '12px 8px' }}>¥{item.subtotal.toLocaleString()}</td>
            </tr>
          ))}
          <tr>
            <td colSpan={3} style={{ padding: '12px 8px', textAlign: 'right', fontWeight: 500 }}>总计:</td>
            <td style={{ padding: '12px 8px', fontWeight: 500 }}>¥{order.totalAmount.toLocaleString()}</td>
          </tr>
        </tbody>
      </table>

      {order.remark && (
        <div style={{ marginBottom: '24px' }}>
          <h2 style={{ fontSize: '16px', marginBottom: '8px' }}>备注</h2>
          <p style={{ color: '#666' }}>{order.remark}</p>
        </div>
      )}

      <h2 style={{ fontSize: '16px', marginBottom: '12px' }}>状态操作</h2>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        {['pending', 'confirmed', 'shipped', 'completed', 'cancelled'].map(s => (
          <button
            key={s}
            onClick={() => updateStatus(s)}
            disabled={updating || order.status === s}
            style={{
              padding: '6px 16px',
              border: '1px solid #ddd',
              borderRadius: '4px',
              background: order.status === s ? STATUS_COLORS[s] : '#fff',
              color: order.status === s ? '#fff' : '#333',
              cursor: order.status === s ? 'default' : 'pointer',
              opacity: order.status === s ? 1 : 0.7,
            }}
          >
            {STATUS_LABELS[s]}
          </button>
        ))}
      </div>
    </div>
  );
}
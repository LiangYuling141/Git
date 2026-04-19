'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

interface Customer {
  id: string;
  name: string;
  phone: string;
}

interface OrderItem {
  productId: string;
  productName: string;
  quantity: number;
  price: number;
  subtotal: number;
}

export default function NewOrderPage() {
  const router = useRouter();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerId, setCustomerId] = useState('');
  const [items, setItems] = useState<OrderItem[]>([{ productId: '', productName: '', quantity: 1, price: 0, subtotal: 0 }]);
  const [remark, setRemark] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch('/api/customers')
      .then(r => r.json())
      .then(data => setCustomers(Array.isArray(data) ? data : []));
  }, []);

  const totalAmount = items.reduce((sum, item) => sum + item.subtotal, 0);

  const updateItem = (index: number, field: keyof OrderItem, value: string | number) => {
    const newItems = [...items];
    (newItems[index] as Record<string, unknown>)[field] = value;
    if (field === 'quantity' || field === 'price') {
      newItems[index].subtotal = Number(newItems[index].quantity) * Number(newItems[index].price);
    }
    setItems(newItems);
  };

  const addItem = () => {
    setItems([...items, { productId: '', productName: '', quantity: 1, price: 0, subtotal: 0 }]);
  };

  const removeItem = (index: number) => {
    if (items.length > 1) setItems(items.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customerId || items.length === 0) {
      setError('请选择客户并添加商品');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId, items, totalAmount, remark }),
      });
      const data = await res.json();
      if (res.ok) {
        router.push(`/orders/${data.id}`);
      } else {
        setError(data.error || '创建失败');
      }
    } catch {
      setError('网络错误');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ padding: '24px', maxWidth: '800px' }}>
      <div style={{ marginBottom: '24px' }}>
        <Link href="/orders" style={{ color: '#1890ff' }}>← 返回订单列表</Link>
      </div>
      <h1 style={{ marginBottom: '24px' }}>新建订单</h1>
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', marginBottom: '4px', fontWeight: 500 }}>客户 *</label>
          <select
            value={customerId}
            onChange={e => setCustomerId(e.target.value)}
            style={{ width: '100%', padding: '8px 12px', border: '1px solid #ddd', borderRadius: '4px' }}
            required
          >
            <option value="">请选择客户</option>
            {customers.map(c => (
              <option key={c.id} value={c.id}>{c.name} - {c.phone}</option>
            ))}
          </select>
        </div>

        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', marginBottom: '8px', fontWeight: 500 }}>商品明细</label>
          {items.map((item, index) => (
            <div key={index} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr auto', gap: '8px', marginBottom: '8px', alignItems: 'center' }}>
              <input
                placeholder="商品名称"
                value={item.productName}
                onChange={e => updateItem(index, 'productName', e.target.value)}
                style={{ padding: '8px', border: '1px solid #ddd', borderRadius: '4px' }}
              />
              <input
                type="number"
                placeholder="数量"
                value={item.quantity}
                onChange={e => updateItem(index, 'quantity', Number(e.target.value))}
                style={{ padding: '8px', border: '1px solid #ddd', borderRadius: '4px' }}
              />
              <input
                type="number"
                placeholder="单价"
                value={item.price}
                onChange={e => updateItem(index, 'price', Number(e.target.value))}
                style={{ padding: '8px', border: '1px solid #ddd', borderRadius: '4px' }}
              />
              <span style={{ textAlign: 'right', fontWeight: 500 }}>¥{item.subtotal.toLocaleString()}</span>
              <button type="button" onClick={() => removeItem(index)} style={{ padding: '4px 8px', color: '#ff4d4f', border: 'none', background: 'none', cursor: 'pointer' }}>×</button>
            </div>
          ))}
          <button type="button" onClick={addItem} style={{ padding: '4px 12px', border: '1px dashed #999', borderRadius: '4px', background: 'none', cursor: 'pointer' }}>+ 添加商品</button>
        </div>

        <div style={{ marginBottom: '16px', fontSize: '18px', fontWeight: 500 }}>
          总计: ¥{totalAmount.toLocaleString()}
        </div>

        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', marginBottom: '4px', fontWeight: 500 }}>备注</label>
          <textarea
            value={remark}
            onChange={e => setRemark(e.target.value)}
            style={{ width: '100%', padding: '8px 12px', border: '1px solid #ddd', borderRadius: '4px', minHeight: '80px' }}
          />
        </div>

        {error && <p style={{ color: 'red', marginBottom: '16px' }}>{error}</p>}
        <button
          type="submit"
          disabled={submitting}
          style={{ padding: '8px 24px', background: '#1890ff', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
        >
          {submitting ? '创建中...' : '创建订单'}
        </button>
      </form>
    </div>
  );
}
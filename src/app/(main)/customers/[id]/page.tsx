'use client';
import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';

interface Customer {
  id: string;
  name: string;
  phone: string;
  email?: string;
  address?: string;
  creditLimit: number;
  creditLine: number;
  isHighRisk: boolean;
  monthlyTransaction: number;
  createdAt: string;
  updatedAt: string;
}

export default function CustomerDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Partial<Customer>>({});
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    fetch(`/api/customers?id=${id}`)
      .then(r => r.json())
      .then(data => {
        setCustomer(data);
        setForm(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [id]);

  const handleSave = async () => {
    const res = await fetch(`/api/customers/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    if (res.ok) {
      setEditing(false);
      const updated = await res.json();
      setCustomer(updated);
    }
  };

  const handleDelete = async () => {
    if (!confirm('确定要删除该客户吗？此操作不可撤销。')) return;
    setDeleting(true);
    const res = await fetch(`/api/customers/${id}`, { method: 'DELETE' });
    if (res.ok) {
      router.push('/customers');
    } else {
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-64">
        <p className="text-gray-500">加载中...</p>
      </div>
    );
  }

  if (!customer) {
    return (
      <div className="flex flex-col items-center justify-center min-h-64 space-y-4">
        <p className="text-gray-500">客户不存在</p>
        <Link href="/customers" className="text-blue-600 hover:text-blue-700 text-sm">
          返回客户列表
        </Link>
      </div>
    );
  }

  const fields: Array<{ label: string; key: keyof Customer; type?: string }> = [
    { label: '名称', key: 'name' },
    { label: '电话', key: 'phone' },
    { label: '邮箱', key: 'email' },
    { label: '地址', key: 'address' },
    { label: '信用额度', key: 'creditLimit', type: 'number' },
    { label: '信用余额', key: 'creditLine', type: 'number' },
    { label: '月交易额', key: 'monthlyTransaction', type: 'number' },
  ];

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <Link href="/customers" className="text-blue-600 hover:text-blue-700 text-sm font-medium">
          ← 返回客户列表
        </Link>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-bold text-gray-900">
            {editing ? '编辑客户' : customer.name}
          </h1>
          {!editing ? (
            <button
              onClick={() => setEditing(true)}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              编辑
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <button
                onClick={handleSave}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
              >
                保存
              </button>
              <button
                onClick={() => { setEditing(false); setForm(customer); }}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                取消
              </button>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {fields.map(({ label, key, type }) => (
            <div key={key} className="p-4 bg-gray-50 rounded-lg">
              <div className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">{label}</div>
              {editing ? (
                <input
                  type={type || 'text'}
                  value={(form[key] as string | number) ?? ''}
                  onChange={e => setForm({ ...form, [key]: type === 'number' ? Number(e.target.value) : e.target.value })}
                  className="w-full px-3 py-1.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm"
                />
              ) : (
                <div className="text-sm font-medium text-gray-900">
                  {(customer[key] as string | number) || '-'}
                </div>
              )}
            </div>
          ))}

          <div className="p-4 bg-gray-50 rounded-lg">
            <div className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">高风险</div>
            <div className="text-sm font-medium">
              {customer.isHighRisk ? (
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">是</span>
              ) : (
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">否</span>
              )}
            </div>
          </div>

          <div className="p-4 bg-gray-50 rounded-lg">
            <div className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">创建时间</div>
            <div className="text-sm text-gray-600">
              {new Date(customer.createdAt).toLocaleString()}
            </div>
          </div>
        </div>

        <div className="mt-6 pt-6 border-t border-gray-200">
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {deleting ? '删除中...' : '删除客户'}
          </button>
        </div>
      </div>
    </div>
  );
}
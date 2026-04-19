'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

type EnterpriseType = 'manufacturer' | 'trader' | 'ecommerce' | 'other';
type MonthlyOrderVolume = 'less_than_10' | '10_to_50' | '50_to_100' | 'more_than_100';
type MainMarket = 'domestic' | 'export' | 'import' | 'transit';
type CustomerSource = 'active_acquisition' | 'exhibition' | 'referral' | 'online_promotion';

interface OnboardingData {
  enterpriseType: EnterpriseType;
  monthlyOrderVolume: MonthlyOrderVolume;
  mainMarket: MainMarket;
  customerSource: CustomerSource;
}

export default function NewCustomerPage() {
  const router = useRouter();
  const [form, setForm] = useState({
    name: '',
    phone: '',
    email: '',
    address: '',
    creditLimit: '0',
  });
  const [onboarding, setOnboarding] = useState<OnboardingData>({
    enterpriseType: 'manufacturer',
    monthlyOrderVolume: 'less_than_10',
    mainMarket: 'domestic',
    customerSource: 'active_acquisition',
  });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name || !form.phone) {
      setError('名称和电话为必填项');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, creditLimit: Number(form.creditLimit) }),
      });
      const data = await res.json();
      if (res.ok) {
        // Start onboarding process
        await fetch('/api/onboarding', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            customerId: data.id,
            onboardingData: onboarding,
          }),
        });
        router.push(`/customers/${data.id}`);
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
    <div className="max-w-2xl">
      <div className="mb-6">
        <Link href="/customers" className="text-blue-600 hover:text-blue-700 text-sm font-medium">
          ← 返回客户列表
        </Link>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <h1 className="text-xl font-bold text-gray-900 mb-6">新建客户</h1>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              名称 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              电话 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={form.phone}
              onChange={e => setForm({ ...form, phone: e.target.value })}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">邮箱</label>
            <input
              type="email"
              value={form.email}
              onChange={e => setForm({ ...form, email: e.target.value })}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">地址</label>
            <input
              type="text"
              value={form.address}
              onChange={e => setForm({ ...form, address: e.target.value })}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">信用额度</label>
            <input
              type="number"
              value={form.creditLimit}
              onChange={e => setForm({ ...form, creditLimit: e.target.value })}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            />
          </div>

          {/* Onboarding Questionnaire */}
          <div className="border-t border-gray-200 pt-5 mt-5">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">入驻问卷</h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  企业类型
                </label>
                <select
                  value={onboarding.enterpriseType}
                  onChange={e => setOnboarding({ ...onboarding, enterpriseType: e.target.value as EnterpriseType })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                >
                  <option value="manufacturer">制造商</option>
                  <option value="trader">贸易商</option>
                  <option value="ecommerce">电商卖家</option>
                  <option value="other">其他</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  月订单量估算
                </label>
                <select
                  value={onboarding.monthlyOrderVolume}
                  onChange={e => setOnboarding({ ...onboarding, monthlyOrderVolume: e.target.value as MonthlyOrderVolume })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                >
                  <option value="less_than_10">&lt;10</option>
                  <option value="10_to_50">10-50</option>
                  <option value="50_to_100">50-100</option>
                  <option value="more_than_100">&gt;100</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  主要市场
                </label>
                <select
                  value={onboarding.mainMarket}
                  onChange={e => setOnboarding({ ...onboarding, mainMarket: e.target.value as MainMarket })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                >
                  <option value="domestic">国内</option>
                  <option value="export">出口</option>
                  <option value="import">进口</option>
                  <option value="transit">转口</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  客户来源渠道
                </label>
                <select
                  value={onboarding.customerSource}
                  onChange={e => setOnboarding({ ...onboarding, customerSource: e.target.value as CustomerSource })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                >
                  <option value="active_acquisition">主动获客</option>
                  <option value="exhibition">展会</option>
                  <option value="referral">口碑推荐</option>
                  <option value="online_promotion">网络推广</option>
                </select>
              </div>
            </div>
          </div>

          {error && (
            <p className="text-sm text-red-600">{error}</p>
          )}

          <div className="flex items-center gap-3 pt-4">
            <button
              type="submit"
              disabled={submitting}
              className="px-6 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {submitting ? '创建中...' : '创建'}
            </button>
            <Link
              href="/customers"
              className="px-6 py-2 bg-white text-gray-700 text-sm font-medium rounded-lg border border-gray-300 hover:bg-gray-50 transition-colors"
            >
              取消
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
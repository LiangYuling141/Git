// =============================================================================
// Dashboard Page Component
// =============================================================================

'use client';

import { useState } from 'react';
import Link from 'next/link';

interface StatCard {
  title: string;
  value: string;
  change: string;
  trend: 'up' | 'down' | 'neutral';
}

const stats: StatCard[] = [
  { title: '本月订单', value: '156', change: '+12%', trend: 'up' },
  { title: '客户总数', value: '89', change: '+5%', trend: 'up' },
  { title: '待处理事项', value: '12', change: '-3', trend: 'down' },
  { title: '本月营收', value: '¥2,345,678', change: '+18%', trend: 'up' },
];

const recentOrders = [
  { id: 'ORD-2026-001', customer: '义乌市伟业进出口有限公司', amount: 125000, status: 'pending', date: '2026-04-19' },
  { id: 'ORD-2026-002', customer: '杭州数码科技有限公司', amount: 56000, status: 'confirmed', date: '2026-04-18' },
  { id: 'ORD-2026-003', customer: '宁波外贸服饰', amount: 89000, status: 'shipped', date: '2026-04-18' },
  { id: 'ORD-2026-004', customer: '温州小商品批发', amount: 34000, status: 'completed', date: '2026-04-17' },
];

const statusMap: Record<string, { label: string; color: string }> = {
  pending: { label: '待处理', color: 'bg-yellow-100 text-yellow-800' },
  confirmed: { label: '已确认', color: 'bg-blue-100 text-blue-800' },
  shipped: { label: '已发货', color: 'bg-purple-100 text-purple-800' },
  completed: { label: '已完成', color: 'bg-green-100 text-green-800' },
};

export default function DashboardPage() {
  return (
    <div className="space-y-6">
      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((stat) => (
          <div key={stat.title} className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-gray-500">{stat.title}</span>
              <span className={`text-xs font-medium ${
                stat.trend === 'up' ? 'text-green-600' :
                stat.trend === 'down' ? 'text-red-600' : 'text-gray-600'
              }`}>
                {stat.change}
              </span>
            </div>
            <div className="mt-2 flex items-baseline">
              <span className="text-2xl font-bold text-gray-900">{stat.value}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Quick Actions */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 className="text-lg font-semibold mb-4">快捷操作</h2>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <Link href="/customers" className="flex flex-col items-center p-4 rounded-lg border border-gray-200 hover:border-blue-500 hover:bg-blue-50 transition-colors">
            <span className="text-2xl mb-2">👥</span>
            <span className="text-sm font-medium text-gray-700">客户管理</span>
          </Link>
          <Link href="/customers/new" className="flex flex-col items-center p-4 rounded-lg border border-gray-200 hover:border-blue-500 hover:bg-blue-50 transition-colors">
            <span className="text-2xl mb-2">👤</span>
            <span className="text-sm font-medium text-gray-700">新建客户</span>
          </Link>
          <Link href="/orders/new" className="flex flex-col items-center p-4 rounded-lg border border-gray-200 hover:border-blue-500 hover:bg-blue-50 transition-colors">
            <span className="text-2xl mb-2">📦</span>
            <span className="text-sm font-medium text-gray-700">创建订单</span>
          </Link>
          <Link href="/chat" className="flex flex-col items-center p-4 rounded-lg border border-gray-200 hover:border-blue-500 hover:bg-blue-50 transition-colors">
            <span className="text-2xl mb-2">💬</span>
            <span className="text-sm font-medium text-gray-700">AI 助手</span>
          </Link>
          <Link href="/reports" className="flex flex-col items-center p-4 rounded-lg border border-gray-200 hover:border-blue-500 hover:bg-blue-50 transition-colors">
            <span className="text-2xl mb-2">📊</span>
            <span className="text-sm font-medium text-gray-700">数据报表</span>
          </Link>
        </div>
      </div>

      {/* Recent Orders */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">最近订单</h2>
          <Link href="/orders" className="text-sm text-blue-600 hover:text-blue-700">查看全部 →</Link>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="text-left py-3 px-4 text-xs font-medium text-gray-500 uppercase">订单号</th>
                <th className="text-left py-3 px-4 text-xs font-medium text-gray-500 uppercase">客户</th>
                <th className="text-left py-3 px-4 text-xs font-medium text-gray-500 uppercase">金额</th>
                <th className="text-left py-3 px-4 text-xs font-medium text-gray-500 uppercase">状态</th>
                <th className="text-left py-3 px-4 text-xs font-medium text-gray-500 uppercase">日期</th>
              </tr>
            </thead>
            <tbody>
              {recentOrders.map((order) => (
                <tr key={order.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="py-3 px-4 text-sm font-medium text-blue-600">{order.id}</td>
                  <td className="py-3 px-4 text-sm text-gray-700">{order.customer}</td>
                  <td className="py-3 px-4 text-sm font-medium text-gray-900">¥{order.amount.toLocaleString()}</td>
                  <td className="py-3 px-4">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusMap[order.status].color}`}>
                      {statusMap[order.status].label}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-sm text-gray-500">{order.date}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

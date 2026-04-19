'use client';
import { useState, useEffect } from 'react';

interface WhitelistEntry {
  id: string;
  userId: string;
  level: string;
  passedRate: number;
  monthlyTransaction: number;
  enteredAt: string;
  lastEvaluatedAt: string;
  user?: { userName: string; email?: string };
}

const LEVEL_COLORS: Record<string, string> = {
  none: '#999',
  WL1: '#52c41a',
  WL2: '#1890ff',
  WL3: '#722ed1',
};

const LEVEL_LABELS: Record<string, string> = {
  none: '无',
  WL1: 'WL1 (快速通道)',
  WL2: 'WL2 (增强通道)',
  WL3: 'WL3 (VIP通道)',
};

export default function WhitelistPage() {
  const [entries, setEntries] = useState<WhitelistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newUserId, setNewUserId] = useState('');
  const [newLevel, setNewLevel] = useState('WL1');
  const [submitting, setSubmitting] = useState(false);

  const fetchEntries = () => {
    fetch('/api/whitelist')
      .then(r => r.json())
      .then(data => {
        setEntries(Array.isArray(data) ? data : []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };

  useEffect(() => {
    fetchEntries();
  }, []);

  const handleAdd = async () => {
    if (!newUserId) return;
    setSubmitting(true);
    try {
      await fetch('/api/whitelist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: newUserId, level: newLevel }),
      });
      setNewUserId('');
      setShowAdd(false);
      fetchEntries();
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (userId: string) => {
    if (!confirm('确定要从白名单移除吗？')) return;
    await fetch(`/api/whitelist?userId=${userId}`, { method: 'DELETE' });
    fetchEntries();
  };

  const handleUpdateLevel = async (userId: string, level: string) => {
    await fetch('/api/whitelist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, level }),
    });
    fetchEntries();
  };

  return (
    <div style={{ padding: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '24px' }}>
        <h1>白名单管理</h1>
        <button
          onClick={() => setShowAdd(!showAdd)}
          style={{ padding: '8px 16px', background: '#1890ff', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
        >
          + 添加白名单
        </button>
      </div>

      {showAdd && (
        <div style={{ marginBottom: '24px', padding: '16px', background: '#f5f5f5', borderRadius: '8px' }}>
          <h3 style={{ marginBottom: '12px' }}>添加白名单</h3>
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
            <input
              placeholder="用户ID"
              value={newUserId}
              onChange={e => setNewUserId(e.target.value)}
              style={{ padding: '8px 12px', border: '1px solid #ddd', borderRadius: '4px', flex: 1 }}
            />
            <select
              value={newLevel}
              onChange={e => setNewLevel(e.target.value)}
              style={{ padding: '8px 12px', border: '1px solid #ddd', borderRadius: '4px' }}
            >
              {Object.entries(LEVEL_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
            <button
              onClick={handleAdd}
              disabled={submitting || !newUserId}
              style={{ padding: '8px 16px', background: '#52c41a', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
            >
              {submitting ? '添加中...' : '添加'}
            </button>
            <button
              onClick={() => setShowAdd(false)}
              style={{ padding: '8px 16px', border: '1px solid #ddd', borderRadius: '4px', cursor: 'pointer' }}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <p>加载中...</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #eee', textAlign: 'left' }}>
              {['用户', '白名单等级', '通过率', '月交易额', '加入时间', '最近评估', '操作'].map(h => (
                <th key={h} style={{ padding: '12px 8px', color: '#666' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {entries.map(entry => (
              <tr key={entry.id} style={{ borderBottom: '1px solid #eee' }}>
                <td style={{ padding: '12px 8px' }}>
                  <div style={{ fontWeight: 500 }}>{entry.user?.userName || entry.userId}</div>
                  <div style={{ fontSize: '12px', color: '#999' }}>{entry.user?.email || entry.userId.substring(0, 12)}...</div>
                </td>
                <td style={{ padding: '12px 8px' }}>
                  <select
                    value={entry.level}
                    onChange={e => handleUpdateLevel(entry.userId, e.target.value)}
                    style={{
                      padding: '4px 8px',
                      border: '1px solid',
                      borderColor: LEVEL_COLORS[entry.level],
                      borderRadius: '4px',
                      color: LEVEL_COLORS[entry.level],
                      background: LEVEL_COLORS[entry.level] + '10',
                    }}
                  >
                    {Object.entries(LEVEL_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </td>
                <td style={{ padding: '12px 8px' }}>{(entry.passedRate * 100).toFixed(1)}%</td>
                <td style={{ padding: '12px 8px' }}>¥{entry.monthlyTransaction.toLocaleString()}</td>
                <td style={{ padding: '12px 8px' }}>{new Date(entry.enteredAt).toLocaleDateString()}</td>
                <td style={{ padding: '12px 8px' }}>{new Date(entry.lastEvaluatedAt).toLocaleDateString()}</td>
                <td style={{ padding: '12px 8px' }}>
                  <button
                    onClick={() => handleDelete(entry.userId)}
                    style={{ padding: '4px 8px', color: '#ff4d4f', border: '1px solid #ff4d4f', borderRadius: '4px', background: 'none', cursor: 'pointer' }}
                  >
                    移除
                  </button>
                </td>
              </tr>
            ))}
            {entries.length === 0 && (
              <tr>
                <td colSpan={7} style={{ padding: '24px', textAlign: 'center', color: '#999' }}>
                  暂无白名单记录
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
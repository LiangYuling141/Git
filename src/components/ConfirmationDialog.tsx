'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

interface ConfirmationRequest {
  id: string;
  operation: {
    type: string;
    entity: string;
    data?: Record<string, unknown>;
    description: string;
  };
  riskLevel: string;
  status: string;
  createdAt: string;
  expiresAt: string;
}

interface ConfirmationDialogProps {
  userId: string;
}

export function ConfirmationDialog({ userId }: ConfirmationDialogProps) {
  const [requests, setRequests] = useState<ConfirmationRequest[]>([]);
  const [current, setCurrent] = useState<ConfirmationRequest | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const router = useRouter();

  // Poll for pending confirmations every 5 seconds
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch(`/api/confirmations?userId=${userId}&status=pending`);
        if (res.ok) {
          const data = await res.json();
          setRequests(Array.isArray(data) ? data : []);
          if (data.length > 0 && !current) {
            setCurrent(data[0]);
          }
        }
      } catch {
        // ignore polling errors
      }
    };

    poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, [userId, current]);

  const handleConfirm = async () => {
    if (!current) return;
    setActionLoading(true);
    try {
      const res = await fetch('/api/confirmations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: current.id, action: 'approve' }),
      });
      if (res.ok) {
        // Move to next or close
        const remaining = requests.filter(r => r.id !== current.id);
        setRequests(remaining);
        setCurrent(remaining[0] || null);
        // Refresh page to show result
        router.refresh();
      }
    } finally {
      setActionLoading(false);
    }
  };

  const handleReject = async () => {
    if (!current) return;
    setActionLoading(true);
    try {
      const res = await fetch('/api/confirmations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: current.id, action: 'reject' }),
      });
      if (res.ok) {
        const remaining = requests.filter(r => r.id !== current.id);
        setRequests(remaining);
        setCurrent(remaining[0] || null);
      }
    } finally {
      setActionLoading(false);
    }
  };

  if (!current) return null;

  return (
    <div style={{
      position: 'fixed',
      top: 0, left: 0, right: 0, bottom: 0,
      background: 'rgba(0,0,0,0.5)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 9999,
    }}>
      <div style={{
        background: '#fff',
        borderRadius: '12px',
        padding: '32px',
        maxWidth: '500px',
        width: '90%',
        boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
          <span style={{ fontSize: '24px' }}>⚠️</span>
          <h2 style={{ margin: 0, fontSize: '20px' }}>操作确认</h2>
        </div>

        <div style={{ marginBottom: '16px' }}>
          <div style={{ color: '#666', marginBottom: '4px' }}>风险等级</div>
          <span style={{
            display: 'inline-block',
            padding: '2px 8px',
            borderRadius: '4px',
            background: current.riskLevel === 'L2' ? '#ff4d4f20' : '#faad1420',
            color: current.riskLevel === 'L2' ? '#ff4d4f' : '#faad14',
            fontWeight: 500,
          }}>
            {current.riskLevel}
          </span>
        </div>

        <div style={{ marginBottom: '16px' }}>
          <div style={{ color: '#666', marginBottom: '4px' }}>操作类型</div>
          <div style={{ fontWeight: 500 }}>
            {current.operation.type} / {current.operation.entity}
          </div>
        </div>

        <div style={{ marginBottom: '16px' }}>
          <div style={{ color: '#666', marginBottom: '4px' }}>操作描述</div>
          <div style={{ color: '#333' }}>{current.operation.description}</div>
        </div>

        {current.operation.data && (
          <div style={{ marginBottom: '16px' }}>
            <div style={{ color: '#666', marginBottom: '4px' }}>操作数据</div>
            <pre style={{
              background: '#f5f5f5',
              padding: '12px',
              borderRadius: '4px',
              overflow: 'auto',
              fontSize: '12px',
              maxHeight: '150px',
            }}>
              {JSON.stringify(current.operation.data, null, 2)}
            </pre>
          </div>
        )}

        <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
          <button
            onClick={handleReject}
            disabled={actionLoading}
            style={{
              padding: '8px 24px',
              border: '1px solid #ddd',
              borderRadius: '4px',
              background: '#fff',
              cursor: 'pointer',
            }}
          >
            取消操作
          </button>
          <button
            onClick={handleConfirm}
            disabled={actionLoading}
            style={{
              padding: '8px 24px',
              background: '#1890ff',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
            }}
          >
            {actionLoading ? '处理中...' : '确认执行'}
          </button>
        </div>

        {requests.length > 1 && (
          <div style={{ marginTop: '16px', fontSize: '12px', color: '#999', textAlign: 'center' }}>
            还有 {requests.length - 1} 个待确认请求
          </div>
        )}
      </div>
    </div>
  );
}
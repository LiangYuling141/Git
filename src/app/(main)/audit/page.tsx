'use client';
import { useState, useEffect } from 'react';

interface AuditLog {
  id: string;
  timestamp: string;
  userId: string;
  operation: string;
  entity: string;
  entityId: string;
  result: string;
  before?: unknown;
  after?: unknown;
  errorMessage?: string;
}

const RESULT_COLORS: Record<string, string> = {
  success: '#52c41a',
  failure: '#ff4d4f',
};

const RESULT_LABELS: Record<string, string> = {
  success: '成功',
  failure: '失败',
};

export default function AuditPage() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/audit')
      .then(r => r.json())
      .then(data => {
        setLogs(Array.isArray(data) ? data : []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  return (
    <div style={{ padding: '24px' }}>
      <h1 style={{ marginBottom: '24px' }}>审计日志</h1>

      {loading ? (
        <p>加载中...</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #eee', textAlign: 'left' }}>
                {['时间', '用户', '操作', '实体', '实体ID', '结果', '操作'].map(h => (
                  <th key={h} style={{ padding: '12px 8px', color: '#666' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {logs.map(log => (
                <tr key={log.id} style={{ borderBottom: '1px solid #eee' }}>
                  <td style={{ padding: '10px 8px', whiteSpace: 'nowrap' }}>
                    {new Date(log.timestamp).toLocaleString()}
                  </td>
                  <td style={{ padding: '10px 8px' }}>{log.userId.substring(0, 8)}...</td>
                  <td style={{ padding: '10px 8px' }}>
                    <span style={{
                      padding: '2px 8px',
                      borderRadius: '4px',
                      background: log.operation === 'create' ? '#e6f7ff' :
                                 log.operation === 'delete' ? '#fff2e6' : '#f5f5f5',
                      fontSize: '12px',
                    }}>
                      {log.operation}
                    </span>
                  </td>
                  <td style={{ padding: '10px 8px' }}>{log.entity}</td>
                  <td style={{ padding: '10px 8px', fontFamily: 'monospace', fontSize: '12px' }}>
                    {log.entityId.substring(0, 12)}...
                  </td>
                  <td style={{ padding: '10px 8px' }}>
                    <span style={{ color: RESULT_COLORS[log.result] || '#999', fontWeight: 500 }}>
                      {RESULT_LABELS[log.result] || log.result}
                    </span>
                  </td>
                  <td style={{ padding: '10px 8px' }}>
                    <button
                      onClick={() => setExpandedId(expandedId === log.id ? null : log.id)}
                      style={{ padding: '2px 8px', cursor: 'pointer', fontSize: '12px' }}
                    >
                      {expandedId === log.id ? '收起' : '详情'}
                    </button>
                  </td>
                </tr>
              ))}
              {logs.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ padding: '24px', textAlign: 'center', color: '#999' }}>
                    暂无审计日志
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {expandedId && logs.find(l => l.id === expandedId) && (
            <div style={{
              marginTop: '16px',
              padding: '16px',
              background: '#f5f5f5',
              borderRadius: '8px',
              fontSize: '13px',
            }}>
              <h4 style={{ marginBottom: '12px' }}>详情</h4>
              {logs.find(l => l.id === expandedId)?.before != null && (
                <div style={{ marginBottom: '8px' }}>
                  <strong>变更前：</strong>
                  <pre style={{ background: '#fff', padding: '8px', borderRadius: '4px', overflow: 'auto', maxHeight: '200px' }}>
                    {JSON.stringify(logs.find(l => l.id === expandedId)?.before as Record<string, unknown>, null, 2)}
                  </pre>
                </div>
              )}
              {logs.find(l => l.id === expandedId)?.after != null && (
                <div>
                  <strong>变更后：</strong>
                  <pre style={{ background: '#fff', padding: '8px', borderRadius: '4px', overflow: 'auto', maxHeight: '200px' }}>
                    {JSON.stringify(logs.find(l => l.id === expandedId)?.after as Record<string, unknown>, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
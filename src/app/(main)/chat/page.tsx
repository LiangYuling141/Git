// =============================================================================
// Chat Interface — TEF 闭环演示界面
//
// 确认卡片展示的是服务端返回的 diff 与判定依据，不是模型摘要。
// 这是 §9.5 风险登记里"人工确认疲劳"的主要对策：批准的人必须能看到真正
// 将要发生什么，否则确认就退化成盲目点击。
// =============================================================================

'use client';

import { useEffect, useRef, useState } from 'react';
import { resolveCardResolution } from './confirm-resolution';

interface DiffChange {
  field: string;
  before?: unknown;
  after?: unknown;
  delta?: number;
}

interface DiffEntry {
  entity: string;
  action: string;
  label?: string;
  changes: DiffChange[];
}

interface ClarifyCandidate {
  id: string;
  label: string;
  matchReason: string;
}

interface ClarifyQuestion {
  slot: string;
  reason: 'ambiguous' | 'missing' | 'invalid';
  candidates?: ClarifyCandidate[];
}

interface ToolCall {
  tool: string;
  status: string;
}

interface MessageMeta {
  status?: string;
  risk?: string;
  reasons?: string[];
  diff?: DiffEntry[];
  questions?: ClarifyQuestion[];
  confirmationToken?: string;
  expiresAt?: string;
  traceId?: string;
  auditId?: string;
  toolCalls?: ToolCall[];
  intentSource?: 'model' | 'deterministic';
  errorCode?: string;
  resolved?: 'executed' | 'rejected' | 'conflict' | 'failed';
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  meta?: MessageMeta;
}

const WELCOME: Message = {
  id: 'welcome',
  role: 'assistant',
  content:
    '我是 LyMtrix-TEF 参考实现助手。业务写入必须经过 preview → confirm → execute，我不会直接改数据。\n\n可以试试：\n· 给伟业公司下一单，5000 个圣诞球，单价 2 块，先付 30% 定金，余款 30 天账期\n· 查一下伟业公司的信用额度\n· 圣诞球还有多少库存',
  timestamp: new Date(),
};

const RISK_STYLE: Record<string, string> = {
  L0: 'bg-green-100 text-green-800',
  L1: 'bg-yellow-100 text-yellow-800',
  L2: 'bg-orange-100 text-orange-800',
  Block: 'bg-red-100 text-red-800',
};

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return value.toLocaleString('zh-CN');
  if (Array.isArray(value)) return value.map((item) => formatValue(item)).join('，');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([WELCOME]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [conversationId] = useState<string>(() =>
    typeof window === 'undefined' ? 'conv_demo' : `conv_${window.localStorage.getItem('sessionId') ?? 'demo'}`,
  );
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  function pushAssistant(content: string, meta?: MessageMeta) {
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: 'assistant', content, timestamp: new Date(), meta },
    ]);
  }

  function markResolved(messageId: string, resolved: MessageMeta['resolved']) {
    setMessages((prev) =>
      prev.map((message) =>
        message.id === messageId ? { ...message, meta: { ...message.meta, resolved } } : message,
      ),
    );
  }

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: 'user', content: trimmed, timestamp: new Date() },
    ]);
    setInput('');
    setLoading(true);

    try {
      const response = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed, conversationId }),
      });
      const data = await response.json();

      if (response.status === 401) {
        pushAssistant('会话未登录或已过期，请先到登录页登录后再试。');
        return;
      }
      if (!response.ok) {
        pushAssistant(`请求失败（${response.status}）：${data.message ?? JSON.stringify(data)}`);
        return;
      }

      pushAssistant(data.reply, {
        status: data.status,
        risk: data.risk,
        reasons: data.reasons,
        diff: data.diff,
        questions: data.questions,
        confirmationToken: data.confirmationToken,
        expiresAt: data.expiresAt,
        traceId: data.traceId,
        auditId: data.auditId,
        toolCalls: data.toolCalls,
        intentSource: data.intentSource,
        errorCode: data.error?.code,
      });
    } catch (error) {
      pushAssistant(`网络错误：${String(error)}`);
    } finally {
      setLoading(false);
    }
  }

  async function decide(messageId: string, token: string, action: 'approve' | 'reject') {
    if (loading) return;
    setLoading(true);
    try {
      const response = await fetch('/api/agent/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmationToken: token, action, conversationId }),
      });
      const data = await response.json();
      // executing / EXECUTION_UNKNOWN 不是确定结果：不把确认卡片标记为已执行
      // 或已拒绝，用户必须能对同一操作再次点击确认（服务端会用同一 token 与
      // 幂等键重试）。拒绝亦如此——它不会撤销可能已经发生的副作用。
      const resolved: MessageMeta['resolved'] = resolveCardResolution({
        ok: response.ok,
        action,
        status: data.status,
      });
      if (resolved) markResolved(messageId, resolved);
      pushAssistant(response.status === 403 ? `无权批准：${data.message}` : data.reply, {
        status: data.status,
        risk: data.risk,
        reasons: data.reasons,
        traceId: data.traceId,
        auditId: data.auditId,
        errorCode: data.error?.code,
        resolved,
      });
    } catch (error) {
      pushAssistant(`确认请求失败：${String(error)}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col h-[calc(100vh-64px)]">
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((message) => (
          <div key={message.id} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[80%] rounded-lg p-4 ${
                message.role === 'user' ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200'
              }`}
            >
              <div className="text-sm whitespace-pre-wrap">{message.content}</div>

              {message.meta?.reasons && message.meta.reasons.length > 0 && (
                <div className="mt-3 text-xs">
                  <div className="font-medium text-gray-600 mb-1">判定依据（服务端契约，非模型判断）</div>
                  <ul className="list-disc pl-4 space-y-0.5 text-gray-600">
                    {message.meta.reasons.map((reason, index) => (
                      <li key={index}>{reason}</li>
                    ))}
                  </ul>
                </div>
              )}

              {message.meta?.diff && message.meta.diff.length > 0 && (
                <div className="mt-3 border border-gray-200 rounded p-3 bg-gray-50">
                  <div className="text-xs font-medium text-gray-700 mb-2">将要发生的变更（服务端计算）</div>
                  <div className="space-y-2">
                    {message.meta.diff.map((entry, index) => (
                      <div key={index} className="text-xs">
                        <div className="text-gray-800">{entry.label ?? `${entry.action} ${entry.entity}`}</div>
                        {entry.changes.length > 0 && (
                          <div className="pl-3 mt-0.5 space-y-0.5 text-gray-600">
                            {entry.changes.map((change, changeIndex) => (
                              <div key={changeIndex}>
                                {change.delta !== undefined ? (
                                  <span>
                                    {change.field}：{change.delta > 0 ? '+' : ''}
                                    {change.delta.toLocaleString('zh-CN')}
                                  </span>
                                ) : (
                                  <span>
                                    {change.field}：{formatValue(change.before)} → {formatValue(change.after)}
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {message.meta?.questions && message.meta.questions.length > 0 && (
                <div className="mt-3 space-y-2">
                  {message.meta.questions.map((question, index) =>
                    question.candidates && question.candidates.length > 0 ? (
                      <div key={index} className="flex flex-wrap gap-2">
                        {question.candidates.map((candidate) => (
                          <button
                            key={candidate.id}
                            type="button"
                            disabled={loading}
                            onClick={() => void send(candidate.label)}
                            title={candidate.matchReason}
                            className="px-3 py-1.5 bg-white border border-blue-300 text-blue-700 text-xs rounded hover:bg-blue-50 disabled:opacity-50"
                          >
                            {candidate.label}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div key={index} className="text-xs text-gray-500">
                        请补充「{question.slot}」。
                      </div>
                    ),
                  )}
                </div>
              )}

              {message.meta?.confirmationToken && !message.meta?.resolved && (
                <div className="mt-3 flex flex-wrap gap-2 items-center">
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => decide(message.id, message.meta?.confirmationToken as string, 'approve')}
                    className="px-3 py-1.5 bg-green-600 text-white text-xs rounded hover:bg-green-700 disabled:opacity-50"
                  >
                    批准并执行
                  </button>
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => decide(message.id, message.meta?.confirmationToken as string, 'reject')}
                    className="px-3 py-1.5 bg-red-600 text-white text-xs rounded hover:bg-red-700 disabled:opacity-50"
                  >
                    拒绝
                  </button>
                  {message.meta.expiresAt && (
                    <span className="text-xs text-gray-400">
                      令牌有效期至 {new Date(message.meta.expiresAt).toLocaleTimeString('zh-CN')}
                    </span>
                  )}
                </div>
              )}

              {message.meta?.resolved && (
                <div className="mt-2 text-xs text-gray-500">
                  {message.meta.resolved === 'executed' && '已执行'}
                  {message.meta.resolved === 'rejected' && '已拒绝'}
                  {message.meta.resolved === 'conflict' && '冲突，需重新预览'}
                  {message.meta.resolved === 'failed' && '失败'}
                </div>
              )}

              <div
                className={`text-xs mt-2 flex flex-wrap gap-2 items-center ${
                  message.role === 'user' ? 'text-blue-200' : 'text-gray-400'
                }`}
              >
                <span>{message.timestamp.toLocaleTimeString('zh-CN')}</span>
                {message.meta?.risk && (
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                      RISK_STYLE[message.meta.risk] ?? 'bg-gray-100 text-gray-800'
                    }`}
                  >
                    {message.meta.risk}
                  </span>
                )}
                {message.meta?.errorCode && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800">
                    {message.meta.errorCode}
                  </span>
                )}
                {message.meta?.intentSource && (
                  <span title="model 表示走了大模型，deterministic 表示走了确定性解析器">
                    意图解析：{message.meta.intentSource}
                  </span>
                )}
                {message.meta?.traceId && <span>trace: {message.meta.traceId}</span>}
                {message.meta?.auditId && <span>audit: {message.meta.auditId}</span>}
              </div>

              {message.meta?.toolCalls && message.meta.toolCalls.length > 0 && (
                <div className="mt-1 text-xs text-gray-400">
                  工具调用：{message.meta.toolCalls.map((call) => `${call.tool}(${call.status})`).join(' → ')}
                </div>
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="bg-white border border-gray-200 rounded-lg p-4">
              <div className="flex items-center space-x-2">
                <div className="w-2 h-2 bg-blue-600 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <div className="w-2 h-2 bg-blue-600 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <div className="w-2 h-2 bg-blue-600 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send(input);
        }}
        className="border-t border-gray-200 p-4 bg-white"
      >
        <div className="flex items-center space-x-4">
          <textarea
            className="flex-1 p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none"
            rows={2}
            placeholder="描述业务需求，例如：给伟业公司下一单，5000 个圣诞球，单价 2 块，先付 30% 定金，余款 30 天账期"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            disabled={loading}
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium"
          >
            发送
          </button>
        </div>
      </form>
    </div>
  );
}

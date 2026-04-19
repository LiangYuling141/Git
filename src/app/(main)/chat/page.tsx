// =============================================================================
// Chat Interface Page
// =============================================================================

'use client';

import { useState, useRef, useEffect } from 'react';
import type { Session } from '@/types';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  riskLevel?: string;
  status?: 'pending' | 'approved' | 'rejected';
  confirmationId?: string;
}

const DEMO_SESSION: Session = {
  id: 'demo-session',
  userId: 'demo-user',
  userName: 'Demo User',
  riskLevel: 'L1',
  createdAt: new Date(),
  metadata: {},
};

const WELCOME_MESSAGE: Message = {
  id: 'welcome',
  role: 'assistant',
  content: '您好！我是 LyMatrix AI 助手。您可以用自然语言描述您的业务需求，例如：\n\n• "帮我查询一下伟业公司的最近订单"\n• "创建一个新客户：张三，电话 13800138000"\n• "查看本月的销售报表"\n\n请注意，金额超过 1 万元的操作需要二次确认。',
  timestamp: new Date(),
};

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([WELCOME_MESSAGE]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [session] = useState<Session>(DEMO_SESSION);
  const [sessionId, setSessionId] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('sessionId') || 'demo-session';
    }
    return 'demo-session';
  });
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || loading) return;

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: input,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setLoading(true);

    try {
      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userInput: input, session: { ...session, id: sessionId } }),
      });
      const data = await res.json();

      // Save sessionId if provided in response
      if (data.sessionId) {
        setSessionId(data.sessionId);
        localStorage.setItem('sessionId', data.sessionId);
      }

      // Handle confirmation requests specially
      if (data.requiresConfirmation) {
        const assistantMessage: Message = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `操作需要确认：\n\n操作类型：${data.decision?.type || '未知'}\n风险等级：${data.riskLevel}\n\n请确认是否执行此操作？`,
          timestamp: new Date(),
          riskLevel: data.riskLevel,
          status: 'pending',
          confirmationId: data.confirmationId,
        };
        setMessages((prev) => [...prev, assistantMessage]);
        return;
      }

      const assistantMessage: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: data.success
          ? data.result
            ? JSON.stringify(data.result, null, 2)
            : '操作已完成'
          : data.error || '处理失败',
        timestamp: new Date(),
        riskLevel: data.riskLevel,
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (error) {
      const errorMessage: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `错误: ${error}`,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async (messageId: string, confirmationId: string) => {
    try {
      await fetch('/api/confirmations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: confirmationId, action: 'approve' }),
      });
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, status: 'approved' as const, content: m.content + '\n\n[已确认执行]' } : m)));
    } catch {
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, status: 'rejected' as const, content: m.content + '\n\n[确认失败]' } : m)));
    }
  };

  const handleReject = async (messageId: string) => {
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, status: 'rejected' as const, content: m.content + '\n\n[已取消]' } : m)));
  };

  return (
    <div className="flex flex-col h-[calc(100vh-64px)]">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[70%] rounded-lg p-4 ${
                msg.role === 'user'
                  ? 'bg-blue-600 text-white'
                  : 'bg-white border border-gray-200'
              }`}
            >
              <div className="text-sm whitespace-pre-wrap">{msg.content}</div>
              <div className={`text-xs mt-2 ${msg.role === 'user' ? 'text-blue-200' : 'text-gray-400'}`}>
                {msg.timestamp.toLocaleTimeString()}
              </div>
              {msg.riskLevel && (
                <div className="mt-2">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                    msg.riskLevel === 'L0' ? 'bg-green-100 text-green-800' :
                    msg.riskLevel === 'L1' ? 'bg-yellow-100 text-yellow-800' :
                    'bg-red-100 text-red-800'
                  }`}>
                    {msg.riskLevel}
                  </span>
                </div>
              )}
              {msg.status === 'pending' && msg.confirmationId && (
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={() => handleConfirm(msg.id, msg.confirmationId!)}
                    className="px-3 py-1 bg-green-600 text-white text-xs rounded hover:bg-green-700"
                  >
                    确认执行
                  </button>
                  <button
                    onClick={() => handleReject(msg.id)}
                    className="px-3 py-1 bg-red-600 text-white text-xs rounded hover:bg-red-700"
                  >
                    取消
                  </button>
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
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="border-t border-gray-200 p-4 bg-white">
        <div className="flex items-center space-x-4">
          <textarea
            className="flex-1 p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none"
            rows={2}
            placeholder="输入您的业务需求..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
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

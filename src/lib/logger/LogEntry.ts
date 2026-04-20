import { LogLevel, LogCategory } from './';

export interface LogEntry {
  id: string;
  timestamp: Date;
  level: LogLevel;
  category: LogCategory;
  message: string;
  component?: string;
  userId?: string;
  sessionId?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}
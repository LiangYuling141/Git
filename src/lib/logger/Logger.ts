import { LogLevel } from './LogLevel';
import type { LogCategory } from './LogCategory';
import type { LogEntry } from './LogEntry';

export interface LogOutput {
  write(entry: LogEntry): void | Promise<void>;
}

export interface LoggerOptions {
  category: LogCategory;
  minLevel: LogLevel;
  component?: string;
}

export class Logger {
  private category: LogCategory;
  private minLevel: LogLevel;
  private component: string;
  private outputs: LogOutput[];

  constructor(options: LoggerOptions, outputs: LogOutput[]) {
    this.category = options.category;
    this.minLevel = options.minLevel;
    this.component = options.component || '';
    this.outputs = outputs;
  }

  debug(message: string, metadata?: Record<string, unknown>): void {
    this.log(LogLevel.DEBUG, message, metadata);
  }

  info(message: string, metadata?: Record<string, unknown>): void {
    this.log(LogLevel.INFO, message, metadata);
  }

  warn(message: string, error?: Error, metadata?: Record<string, unknown>): void {
    this.log(LogLevel.WARN, message, metadata, error);
  }

  error(message: string, error?: Error, metadata?: Record<string, unknown>): void {
    this.log(LogLevel.ERROR, message, metadata, error);
  }

  fatal(message: string, error?: Error, metadata?: Record<string, unknown>): void {
    this.log(LogLevel.FATAL, message, metadata, error);
  }

  private log(
    level: LogLevel,
    message: string,
    metadata?: Record<string, unknown>,
    error?: Error
  ): void {
    if (level < this.minLevel) return;

    const entry: LogEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      level,
      category: this.category,
      message,
      component: this.component,
      metadata,
      error: error
        ? { name: error.name, message: error.message, stack: error.stack }
        : undefined,
    };

    for (const output of this.outputs) {
      try {
        const result = output.write(entry);
        if (result instanceof Promise) {
          result.catch((err) => console.error('[Logger] Async write failed:', err));
        }
      } catch (err) {
        console.error('[Logger] Write failed:', err);
      }
    }
  }
}
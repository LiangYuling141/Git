import { LogLevel } from './LogLevel';
import type { LogCategory } from './LogCategory';
import { Logger } from './Logger';
import type { LogOutput } from './Logger';
import { ConsoleOutput } from './outputs/ConsoleOutput';
import { FileOutput } from './outputs/FileOutput';
import { DatabaseOutput } from './outputs/DatabaseOutput';

export class LoggerManager {
  private loggers: Map<string, Logger> = new Map();
  private outputs: LogOutput[] = [];
  private globalMinLevel: LogLevel = LogLevel.DEBUG;
  private categoryLevels: Map<LogCategory, LogLevel> = new Map();

  configure(options: {
    level: LogLevel;
    enableConsole: boolean;
    enableFile: boolean;
    logDir?: string;
    enableDatabase: boolean;
  }): void {
    this.outputs = [];

    if (options.enableConsole) {
      this.outputs.push(new ConsoleOutput());
    }

    if (options.enableFile) {
      this.outputs.push(new FileOutput(options.logDir || './logs'));
    }

    if (options.enableDatabase) {
      this.outputs.push(new DatabaseOutput());
    }

    this.globalMinLevel = options.level;
  }

  setCategoryLevel(category: LogCategory, level: LogLevel): void {
    this.categoryLevels.set(category, level);
  }

  getLogger(category: LogCategory, component?: string): Logger {
    const key = `${category}:${component || 'default'}`;

    if (!this.loggers.has(key)) {
      const minLevel = this.categoryLevels.get(category) || this.globalMinLevel;
      this.loggers.set(
        key,
        new Logger({ category, minLevel, component }, this.outputs)
      );
    }

    return this.loggers.get(key)!;
  }
}

export const loggerManager = new LoggerManager();
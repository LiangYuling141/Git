import { LogLevel, LogCategory } from './';
import { Logger, LogOutput, LoggerOptions } from './Logger';

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
      const { ConsoleOutput } = require('./outputs/ConsoleOutput');
      this.outputs.push(new ConsoleOutput());
    }

    if (options.enableFile) {
      const { FileOutput } = require('./outputs/FileOutput');
      this.outputs.push(new FileOutput(options.logDir || './logs'));
    }

    if (options.enableDatabase) {
      const { DatabaseOutput } = require('./outputs/DatabaseOutput');
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
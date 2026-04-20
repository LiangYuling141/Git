// =============================================================================
// Logger Configuration
// =============================================================================

import { LogLevel, LogCategory } from './';

export interface LoggerConfig {
  level: LogLevel;
  enableConsole: boolean;
  enableFile: boolean;
  logDir: string;
  enableDatabase: boolean;
}

export function getDefaultConfig(): LoggerConfig {
  const env = process.env.NODE_ENV || 'development';

  return {
    level: env === 'production' ? LogLevel.INFO : LogLevel.DEBUG,
    enableConsole: env !== 'test',
    enableFile: env === 'production',
    logDir: process.env.LOG_DIR || './logs',
    enableDatabase: true,
  };
}

export function initializeLogger(): void {
  const { loggerManager } = require('./');
  const config = getDefaultConfig();

  loggerManager.configure({
    level: config.level,
    enableConsole: config.enableConsole,
    enableFile: config.enableFile,
    logDir: config.logDir,
    enableDatabase: config.enableDatabase,
  });

  // Set category-specific levels
  loggerManager.setCategoryLevel(LogCategory.PERFORMANCE, LogLevel.WARN);
  loggerManager.setCategoryLevel(LogCategory.SYSTEM, LogLevel.DEBUG);
}

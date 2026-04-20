export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  FATAL = 4,
}

export function getLevelName(level: LogLevel): string {
  return LogLevel[level];
}

export function isLevelEnabled(minLevel: LogLevel, currentLevel: LogLevel): boolean {
  return currentLevel >= minLevel;
}
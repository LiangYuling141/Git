import { LogEntry, LogLevel } from '../';
import { LogOutput } from '../Logger';

const LEVEL_COLORS: Record<number, string> = {
  [LogLevel.DEBUG]: '\x1b[36m',   // cyan
  [LogLevel.INFO]: '\x1b[32m',    // green
  [LogLevel.WARN]: '\x1b[33m',    // yellow
  [LogLevel.ERROR]: '\x1b[31m',   // red
  [LogLevel.FATAL]: '\x1b[35m',   // magenta
};

const RESET = '\x1b[0m';

export class ConsoleOutput implements LogOutput {
  write(entry: LogEntry): void {
    const color = LEVEL_COLORS[entry.level] || '';
    const levelName = LogLevel[entry.level];
    const timestamp = entry.timestamp.toISOString();
    const category = entry.category;

    let formatted = `${color}[${timestamp}] ${levelName} [${category}]`;
    if (entry.component) formatted += ` [${entry.component}]`;
    formatted += ` ${entry.message}`;

    if (entry.metadata) {
      formatted += ` ${JSON.stringify(entry.metadata)}`;
    }

    if (entry.error) {
      formatted += `\n  Error: ${entry.error.message}`;
      if (entry.error.stack) {
        formatted += `\n  Stack: ${entry.error.stack}`;
      }
    }

    formatted += RESET;

    if (entry.level >= LogLevel.ERROR) {
      console.error(formatted);
    } else {
      console.log(formatted);
    }
  }
}
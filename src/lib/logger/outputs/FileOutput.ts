import * as fs from 'fs';
import * as path from 'path';
import { LogLevel } from '../LogLevel';
import type { LogEntry } from '../LogEntry';
import type { LogOutput } from '../Logger';

export class FileOutput implements LogOutput {
  private logDir: string;
  private currentDate: string;
  private stream: fs.WriteStream;

  constructor(logDir: string = './logs') {
    this.logDir = logDir;
    this.ensureLogDir();
    this.currentDate = this.getDateString();
    this.stream = this.createStream();
  }

  private ensureLogDir(): void {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  private getDateString(): string {
    return new Date().toISOString().split('T')[0];
  }

  private createStream(): fs.WriteStream {
    const filename = `app-${this.currentDate}.log`;
    const filepath = path.join(this.logDir, filename);
    return fs.createWriteStream(filepath, { flags: 'a' });
  }

  private maybeRotate(): void {
    const today = this.getDateString();
    if (today !== this.currentDate) {
      this.currentDate = today;
      this.stream.end();
      this.stream = this.createStream();
    }
  }

  write(entry: LogEntry): void {
    this.maybeRotate();

    const logLine = JSON.stringify({
      id: entry.id,
      timestamp: entry.timestamp.toISOString(),
      level: LogLevel[entry.level],
      category: entry.category,
      message: entry.message,
      component: entry.component,
      userId: entry.userId,
      sessionId: entry.sessionId,
      requestId: entry.requestId,
      metadata: entry.metadata,
      error: entry.error,
    }) + '\n';

    this.stream.write(logLine);
  }
}
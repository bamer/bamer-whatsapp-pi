import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { createStoragePaths } from './storage-path.js';





export class WhatsAppPiLogger {
    private logDir: string;
    private currentLogFile: string;
    private currentSize = 0;

    constructor(
        private verbose = false,
        private logMaxSizeMB = 5,
        private logRetentionDays = 7
    ) {
        const { logDir } = createStoragePaths();
        this.logDir = logDir;
        try { mkdirSync(logDir, { recursive: true }); } catch {}
        this.cleanOldLogs();
        this.currentLogFile = this.getCurrentLogFile();
        this.currentSize = this.getFileSize(this.currentLogFile);
    }

    updateConfig(logMaxSizeMB: number, logRetentionDays: number) {
        this.logMaxSizeMB = Math.max(1, logMaxSizeMB);
        this.logRetentionDays = Math.max(1, logRetentionDays);
    }

    setVerbose(enabled: boolean) {
        this.verbose = enabled;
    }

    private getCurrentLogFile(): string {
        const files = this.getLogFiles();
        if (files.length === 0) {
            return this.newLogFile();
        }
        const latest = files[files.length - 1];
        if (this.getFileSize(latest) < this.logMaxSizeMB * 1024 * 1024) {
            return latest;
        }
        return this.newLogFile();
    }

    private newLogFile(): string {
        const timestamp = new Date().toISOString().replace(/[:\.]/g, '-');
        return join(this.logDir, `whatsapp-pi-${timestamp}.log`);
    }

    private getLogFiles(): string[] {
        try {
            return readdirSync(this.logDir)
                .filter(f => f.startsWith('whatsapp-pi-') && f.endsWith('.log'))
                .map(f => join(this.logDir, f))
                .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
        } catch {
            return [];
        }
    }

    private getFileSize(path: string): number {
        try { return statSync(path).size; } catch { return 0; }
    }

    private cleanOldLogs() {
        const now = Date.now();
        const maxAge = this.logRetentionDays * 24 * 60 * 60 * 1000;
        for (const file of this.getLogFiles()) {
            try {
                const age = now - statSync(file).mtimeMs;
                if (age > maxAge) {
                    unlinkSync(file);
                }
            } catch {}
        }
        // Also enforce max file count
        const files = this.getLogFiles();
        while (files.length > 10) {
            try { unlinkSync(files.shift()!); } catch {}
        }
    }

    private rotateIfNeeded() {
        if (this.currentSize >= this.logMaxSizeMB * 1024 * 1024) {
            this.currentLogFile = this.newLogFile();
            this.currentSize = 0;
            this.cleanOldLogs();
        }
    }

    private writeToFile(level: string, message: string, args: unknown[]) {
        // Logging disabled
        if (!this.logDir) return;
        this.rotateIfNeeded();
        const timestamp = new Date().toISOString();
        const extra = args.length ? ' ' + args.map(a => String(a)).join(' ') : '';
        const line = `[${timestamp}] [${level}] ${message}${extra}\n`;
        try {
            appendFileSync(this.currentLogFile, line);
            this.currentSize += Buffer.byteLength(line, 'utf8');
        } catch {
            // File logging is best-effort.
        }
    }

    info(message: string, ...args: unknown[]) {
        console.error(message, ...args);
        this.writeToFile('INFO', message, args);
    }

    log(message: string, ...args: unknown[]) {
        this.writeToFile('LOG', message, args);
        if (this.verbose) {
            console.error(message, ...args);
        }
    }

    warn(message: string, ...args: unknown[]) {
        this.writeToFile('WARN', message, args);
        if (this.verbose) {
            console.warn(message, ...args);
        }
    }

    error(message: string, ...args: unknown[]) {
        this.writeToFile('ERROR', message, args);
        if (this.verbose) {
            console.error(message, ...args);
        }
    }
}

// logger.ts

import type { App } from 'obsidian';

export class ConversumLogger {
    private app: App;
    private logPath = '.obsidian/plugins/conversum/conversum.log';
    private maxLogSize = 1024 * 1024; // 1 MB

    constructor(app: App) {
        this.app = app;
    }

    async init(): Promise<void> {
        try {
            const exists = await this.app.vault.adapter.exists(this.logPath);
            if (exists) {
                const stat = await this.app.vault.adapter.stat(this.logPath);
                if (stat && stat.size > this.maxLogSize) {
                    await this.app.vault.adapter.write(this.logPath, `[${new Date().toISOString()}] [INFO] Log rotated\n`);
                }
            } else {
                await this.app.vault.adapter.write(this.logPath, `[${new Date().toISOString()}] [INFO] conversum log initialized\n`);
            }
        } catch (e) {
            console.error('con[VER]sum: Failed to init logfile:', e);
        }
    }

    async log(message: string): Promise<void> {
        const timestamp = new Date().toISOString();
        const line = `[${timestamp}] [INFO] ${message}\n`;
        console.log(`con[VER]sum: ${message}`);
        await this.appendToFile(line);
    }

    async warn(message: string): Promise<void> {
        const timestamp = new Date().toISOString();
        const line = `[${timestamp}] [WARN] ${message}\n`;
        console.warn(`con[VER]sum: ${message}`);
        await this.appendToFile(line);
    }

    async error(message: string, error?: any): Promise<void> {
        const timestamp = new Date().toISOString();
        let errStr = '';
        if (error) {
            errStr = error instanceof Error ? ` | ${error.message}\n${error.stack}` : ` | ${JSON.stringify(error)}`;
        }
        const line = `[${timestamp}] [ERROR] ${message}${errStr}\n`;
        console.error(`con[VER]sum: ${message}`, error);
        await this.appendToFile(line);
    }

    private async appendToFile(text: string): Promise<void> {
        try {
            const exists = await this.app.vault.adapter.exists(this.logPath);
            if (exists) {
                await this.app.vault.adapter.append(this.logPath, text);
            } else {
                await this.app.vault.adapter.write(this.logPath, text);
            }
        } catch {
        }
    }
}

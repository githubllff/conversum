// main.ts

import { Plugin, Notice, Menu, TFile, TAbstractFile, Editor, EditorPosition, MarkdownView } from 'obsidian';
import { IndexDatabase } from './database';
import { initEngine, isEngineReady, getAvailableLanguages, parseReferences, getBookName, decodeScriptures, prewarmEngines, clearEnginePool } from './engine-wrapper';
import { ScriptureIndexer } from './indexer';
import { ConversumLogger } from './logger';
import { RelatedNotesPopout } from './related';
import { ConversumSettingTab } from './settings';
import { ConcordanceView } from './sidebar';
import { ConversumSettings, DEFAULT_SETTINGS, VIEW_TYPE_CONVERSUM_CONCORDANCE, IndexProgress, ReferenceIndexEntry } from './types';

export default class ConversumPlugin extends Plugin {
    settings!: ConversumSettings;
    indexer: ScriptureIndexer | null = null;
    private db: IndexDatabase | null = null;
    private logger: ConversumLogger | null = null;
    private rebuildTimeout: number | null = null;
    private rebuildNotice: Notice | null = null;
    private fileWatcherEnabled = false;
    private pendingFiles = new Set<TFile>();
    private relatedPopout: RelatedNotesPopout | null = null;
    private isStartupComplete = false;
    public settingsTab: ConversumSettingTab | null = null;

    public getDatabase(): IndexDatabase | null {
        return this.db;
    }

    public getLogger(): ConversumLogger | null {
        return this.logger;
    }

    async onload(): Promise<void> {
        this.logger = new ConversumLogger(this.app);
        await this.logger.init();
        await this.logger.log('Plugin initializing...');

        await this.loadSettings();

        try {
            await initEngine();
            await this.logger.log('WASM Engine successfully initialized');
        } catch (e) {
            await this.logger.error('Failed to initialize engine:', e);
            new Notice('con[VER]sum: Failed to initialize engine.');
        }
        // Engines are created lazily to reduce baseline RAM on low-end devices.

        this.db = new IndexDatabase(this);
        await this.db.init();
        this.initIndexer();

        this.registerView(VIEW_TYPE_CONVERSUM_CONCORDANCE, (leaf) => new ConcordanceView(leaf, this));
        this.relatedPopout = new RelatedNotesPopout(this);

        this.settingsTab = new ConversumSettingTab(this.app, this);
        this.addSettingTab(this.settingsTab);

        this.addCommands();
        this.registerEvents();
        this.addRibbonIcon('book-open', 'con[VER]sum Concordance', () => {
            this.openConcordanceView();
        });

        await this.handleStartup();

        if (this.settings.autoIndex) {
            this.startFileWatcher();
        }
        this.isStartupComplete = true;
        await this.logger.log('Plugin loaded and ready');
    }

    async onunload(): Promise<void> {
        this.stopFileWatcher();
        if (this.rebuildTimeout) {
            clearTimeout(this.rebuildTimeout);
            this.rebuildTimeout = null;
        }
        if (this.relatedPopout) {
            this.relatedPopout.forceClose();
            this.relatedPopout = null;
        }
        clearEnginePool();
        if (this.db) {
            await this.db.close();
            this.db = null;
        }
        await this.logger?.log('Plugin unloaded');
    }

    private transformForcedReferences(text: string): string {
        if (!text.includes('{{')) return text;
        return text.replace(/\{\{(.+?)\}\}/g, (_match, inner) => {
            const cleaned = inner.replace(/\*\*/g, '').replace(/\*/g, '');
            return '⟪⟪' + cleaned + '⟫⟫';
        });
    }

    public getUnformattedCount(): number {
        return this.db?.getUnformattedCount() || 0;
    }

    public isFormattingBusy(): boolean {
        return this.indexer?.isFormattingBusy() || false;
    }

    // ============================================================
    // STARTUP FLOW
    // ============================================================

    private async handleStartup(): Promise<void> {
        if (!this.indexer || !this.db) {
            return;
        }

        const dbRefCount = this.db.getReferenceCount();
        const dbOccurrenceCount = this.db.getOccurrenceCount();
        const dbFileCount = this.db.getFileCount();
        await this.logger?.log(
            `Loaded index from disk: ${dbRefCount} refs, ${dbOccurrenceCount} occurrences, ${dbFileCount} files`
        );
        if (dbFileCount > 100 && dbOccurrenceCount < dbFileCount) {
            await this.logger?.warn(
                `Index looks incomplete (${dbOccurrenceCount} occurrences for ${dbFileCount} indexed files). ` +
                `Run "Rebuild index" to repair it.`
            );
        }

        const hasValidData = dbRefCount > 0;
        const rebuildStatus = this.settings.rebuildStatus || 'unknown';

        if (rebuildStatus === 'in_progress' || rebuildStatus === 'failed' || rebuildStatus === 'aborted') {
            await this.logger?.warn(`Previous index rebuild state was '${rebuildStatus}'. Resetting state.`);
            this.settings.rebuildStatus = 'unknown';
            await this.saveSettings();
            if (this.settings.autoIndex) {
                this.app.workspace.onLayoutReady(async () => {
                    await new Promise(resolve => setTimeout(resolve, 500));
                    await this.syncIndexOnStartup();
                });
            }
            return;
        }

        if (hasValidData && this.settings.autoIndex) {
            this.app.workspace.onLayoutReady(async () => {
                await this.syncIndexOnStartup();
            });
            return;
        }

        if (hasValidData && !this.settings.autoIndex) {
            this.refreshConcordanceView();
            this.refreshSettings();
            return;
        }

        if (!hasValidData && this.settings.autoIndex) {
            this.app.workspace.onLayoutReady(async () => {
                await this.rebuildIndex();
            });
            return;
        }

        if (!hasValidData && !this.settings.autoIndex) {
            this.refreshConcordanceView();
            this.refreshSettings();
            return;
        }
    }

    private async syncIndexOnStartup(): Promise<void> {
        if (!this.indexer || !this.db) {
            return;
        }

        const allFiles = this.app.vault.getMarkdownFiles();
        const data = this.db.getData();
        if (!data || Object.keys(data.fileCache).length === 0) {
            await this.rebuildIndex();
            return;
        }

        const fileCache = data.fileCache || {};
        const vaultPaths = new Set(allFiles.map(f => f.path));
        const filesToIndex: TFile[] = [];

        for (const file of allFiles) {
            if (this.indexer.isExcluded(file.path)) continue;
            const cached = fileCache[file.path];
            if (!cached) {
                filesToIndex.push(file);
            } else if (cached.lastModified !== file.stat.mtime) {
                filesToIndex.push(file);
            }
        }

        if (filesToIndex.length > 0) {
            await this.logger?.log(`Startup sync: indexing ${filesToIndex.length} changed files`);
            let syncCount = 0;
            for (const file of filesToIndex) {
                try {
                    await this.indexer.updateFile(file, true);
                } catch (e) {
                    await this.logger?.error(`Startup sync failed on ${file.path}`, e);
                }
                syncCount++;
                if (syncCount % 5 === 0) {
                    await new Promise((resolve) => window.setTimeout(resolve, 0));
                }
            }
        }

        const freshData = this.db.getData();
        const freshFileCache = freshData.fileCache || {};
        for (const cachedPath of Object.keys(freshFileCache)) {
            if (!vaultPaths.has(cachedPath)) {
                await this.indexer.removeFile(cachedPath);
            }
        }

        const unformattedCount = this.db.getUnformattedCount();
        if (unformattedCount > 0) {
            this.indexer.startBackgroundFormatting();
        }

        this.refreshConcordanceView();
        this.refreshSettings();
    }

    // ============================================================
    // SETTINGS
    // ============================================================

    async loadSettings(): Promise<void> {
        const savedData = await this.loadData();
        this.settings = Object.assign({}, DEFAULT_SETTINGS);
        if (savedData) {
            if (typeof savedData.sourceLanguage === 'string') {
                this.settings.sourceLanguage = savedData.sourceLanguage;
            }
            if (typeof savedData.outputLanguage === 'string') {
                this.settings.outputLanguage = savedData.outputLanguage;
            }
            if (savedData.nameFormat === 'full' || savedData.nameFormat === 'standard' || savedData.nameFormat === 'official') {
                this.settings.nameFormat = savedData.nameFormat;
            }
            if (typeof savedData.autoIndex === 'boolean') {
                this.settings.autoIndex = savedData.autoIndex;
            }
            if (typeof savedData.autoBackup === 'boolean') {
                this.settings.autoBackup = savedData.autoBackup;
            }
            if (Array.isArray(savedData.excludedFolders)) {
                this.settings.excludedFolders = savedData.excludedFolders;
            }
            if (typeof savedData.rebuildStatus === 'string') {
                this.settings.rebuildStatus = savedData.rebuildStatus;
            }
        } else {
            this.settings.autoIndex = false;
        }
    }

    async saveSettings(): Promise<void> {
        const dataToSave = {
            sourceLanguage: this.settings.sourceLanguage,
            outputLanguage: this.settings.outputLanguage,
            nameFormat: this.settings.nameFormat,
            autoIndex: this.settings.autoIndex,
            autoBackup: this.settings.autoBackup,
            excludedFolders: this.settings.excludedFolders
        };
        await this.saveData(dataToSave);
    }

    // ============================================================
    // INDEXER
    // ============================================================

    private initIndexer(): void {
        if (!this.db) return;
        this.indexer = new ScriptureIndexer(
            this.app.vault,
            this,
            this.settings.sourceLanguage,
            this.settings.outputLanguage,
            this.settings.nameFormat,
            this.settings.excludedFolders,
            this.manifest.version,
            this.db
        );
    }

    updateIndexerSettings(): void {
        if (this.indexer) {
            this.indexer.updateSettings(
                this.settings.sourceLanguage,
                this.settings.outputLanguage,
                this.settings.nameFormat,
                this.settings.excludedFolders
            );
        }
    }

    async rebuildIndex(): Promise<void> {
        if (!this.indexer) {
            new Notice('Indexer not initialized');
            return;
        }

        if (this.indexer.isBusy()) {
            new Notice('Index rebuild already in progress');
            return;
        }

        if (!isEngineReady()) {
            new Notice('Engine not ready. Please try again.');
            return;
        }

        const notice = new Notice('Building concordance index...', 0);
        this.rebuildNotice = notice;

        // Stop button on the floating notification so an in-progress index
        // can be aborted (e.g. to import a compiled index from the vault).
        const stopBtn = notice.messageEl.createEl('button', { text: 'Stop indexing' });
        stopBtn.style.marginLeft = '10px';
        stopBtn.style.cursor = 'pointer';
        stopBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!this.indexer) return;
            stopBtn.disabled = true;
            stopBtn.textContent = 'Stopping...';
            this.indexer.abort();
            this.logger?.log('Index rebuild stop requested by user');
        });

        const loadBtn = notice.messageEl.createEl('button', { text: 'Load from vault' });
        loadBtn.style.marginLeft = '10px';
        loadBtn.style.cursor = 'pointer';
        loadBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            loadBtn.disabled = true;
            loadBtn.textContent = 'Loading...';
            try {
                this.indexer?.abort();
                await new Promise((resolve) => window.setTimeout(resolve, 300));
                this.forceResetBusyState();
                await this.importDatabaseFromVault();
                notice.hide();
            } catch (err) {
                await this.logger?.error('Load from vault failed', err);
            }
        });

        try {
            const progressCallback = (progress: IndexProgress) => {
                const percent = progress.totalFiles > 0 
                    ? Math.round((progress.processedFiles / progress.totalFiles) * 100) 
                    : 0;
                const fileInfo = progress.currentFile ? ` (${progress.currentFile})` : '';
                notice.setMessage(`Indexing: ${percent}% (${progress.processedFiles}/${progress.totalFiles} files${fileInfo}, ${progress.uniqueReferences} unique refs)`);
                // Re-append the buttons after setMessage replaces the content
                if (!stopBtn.isConnected) {
                    notice.messageEl.appendChild(stopBtn);
                }
                if (!loadBtn.isConnected) {
                    notice.messageEl.appendChild(loadBtn);
                }
            };

            await this.indexer.rebuildIndex(progressCallback);
            const data = this.indexer.getData();
            const wasAborted = this.indexer.wasAborted();
            if (wasAborted) {
                notice.setMessage('Indexing stopped.');
            } else {
                notice.setMessage(`Index complete: ${data ? Object.keys(data.references).length : 0} unique references`);
            }
            setTimeout(() => notice.hide(), 2000);
            this.refreshConcordanceView();
            this.refreshSettings();

        } catch (e) {
            await this.logger?.error('Manual rebuild failed', e);
            notice.setMessage('Index rebuild failed. See conversum.log for details.');
            setTimeout(() => notice.hide(), 3000);
        } finally {
            this.rebuildNotice = null;
        }
    }

    private formatReferenceOnTheFly(entry: ReferenceIndexEntry): string {
        const ranges: Array<[string, string]> = [[entry.startBcv, entry.endBcv]];
        const decoded = decodeScriptures(
            ranges,
            this.settings.outputLanguage,
            this.settings.nameFormat
        );
        return decoded && decoded.length > 0 && decoded[0] ? decoded[0] : `${entry.startBcv}-${entry.endBcv}`;
    }

    public forceResetBusyState(): void {
        this.indexer?.forceResetBusyState();
        this.clearPendingIndexUpdates();
        new Notice('Busy state reset.');
    }

    public async importDatabaseFromVault(): Promise<void> {
        const path = 'conversum-index.db';
        const adapter = this.app.vault.adapter;
        if (!(await adapter.exists(path))) {
            new Notice('No conversum-index.db found at vault root.');
            return;
        }
        try {
            const bytes = await adapter.readBinary(path);
            await this.importDatabase(bytes);
            new Notice('Imported index from vault.');
        } catch (e) {
            await this.logger?.error('Import from vault failed', e);
            const message = e instanceof Error ? e.message : String(e);
            new Notice(`Import failed: ${message}`, 10000);
        }
    }

    public clearPendingIndexUpdates(): void {
        this.pendingFiles.clear();
        if (this.rebuildTimeout) {
            clearTimeout(this.rebuildTimeout);
            this.rebuildTimeout = null;
        }
    }

    public async reformatAllReferences(): Promise<void> {
        if (!this.indexer) return;
        const data = this.indexer.getData();
        if (!data || Object.keys(data.references).length === 0) return;
        await this.indexer.clearFormatted();
        this.indexer.startBackgroundFormatting();
        this.refreshConcordanceView();
        this.refreshSettings();
    }

    // ============================================================
    // DATABASE IMPORT / EXPORT
    // ============================================================

    public async importDatabase(bytes: ArrayBuffer): Promise<void> {
        if (!this.db) {
            throw new Error('Database is not initialized');
        }
        if (this.indexer?.isBusy()) {
            throw new Error('Indexing or formatting is in progress. Wait for it to finish, then try again.');
        }

        const watcherWasEnabled = this.fileWatcherEnabled;
        this.stopFileWatcher();
        try {
            this.indexer?.abort();
            const counts = await this.db.importDatabase(bytes);

            // The imported index was built on another device. Treat matching
            // files as current so timestamp differences do not trigger a full
            // reindex on this device.
            const currentFiles = this.app.vault.getMarkdownFiles().map((file) => ({
                path: file.path,
                lastModified: file.stat.mtime
            }));
            await this.db.updateFileTimestamps(currentFiles);
            this.indexer?.setData(this.db.getData());

            this.settings.rebuildStatus = 'complete';
            try {
                await this.saveSettings();
            } catch {
            }

            this.refreshConcordanceView();
            this.refreshSettings();
            await this.logger?.log(
                `Imported database: ${counts.refs} refs, ${counts.occurrences} occurrences, ${counts.files} files`
            );
            new Notice(
                `Database imported: ${counts.refs} references, ${counts.occurrences} occurrences, ${counts.files} files.`
            );
        } finally {
            if (watcherWasEnabled) {
                this.startFileWatcher();
            }
        }
    }

    public async exportDatabaseToVault(): Promise<string> {
        if (!this.db) {
            throw new Error('Database is not initialized');
        }
        if (this.indexer?.isBusy()) {
            throw new Error('Indexing or formatting is in progress. Wait for it to finish, then try again.');
        }

        const bytes = await this.db.readDatabaseFile();
        if (!bytes) {
            throw new Error('No database file found');
        }

        const exportPath = 'conversum-index.db';
        await this.app.vault.adapter.writeBinary(exportPath, bytes);
        await this.logger?.log(`Exported database to vault root: ${exportPath} (${bytes.byteLength} bytes)`);
        return exportPath;
    }

    // ============================================================
    // FILE WATCHER
    // ============================================================

    startFileWatcher(): void {
        if (this.fileWatcherEnabled) return;
        this.fileWatcherEnabled = true;
    }

    stopFileWatcher(): void {
        this.fileWatcherEnabled = false;
        this.pendingFiles.clear();
        if (this.rebuildTimeout) {
            clearTimeout(this.rebuildTimeout);
            this.rebuildTimeout = null;
        }
    }

    private scheduleIndexUpdate(file: TFile): void {
        if (!this.settings.autoIndex || !this.fileWatcherEnabled) return;
        if (!this.indexer) return;
        if (this.indexer.isExcluded(file.path)) return;

        this.pendingFiles.add(file);

        if (this.rebuildTimeout) {
            clearTimeout(this.rebuildTimeout);
        }

        this.rebuildTimeout = window.setTimeout(async () => {
            const processPending = async (): Promise<void> => {
                if (!this.indexer) return;
                if (this.indexer.isIndexingBusy()) {
                    this.rebuildTimeout = window.setTimeout(processPending, 2000);
                    return;
                }
                const filesToProcess = Array.from(this.pendingFiles);
                this.pendingFiles.clear();
                this.rebuildTimeout = null;

                for (const f of filesToProcess) {
                    try {
                        await this.indexer.updateFile(f, true);
                    } catch (e) {
                        await this.logger?.error(`Failed to update file ${f.path}`, e);
                    }
                }
                this.indexer.startBackgroundFormatting();
                this.refreshConcordanceView();
                this.refreshSettings();
            };
            await processPending();
        }, 1500);
    }

    // ============================================================
    // EVENTS
    // ============================================================

    private registerEvents(): void {
        this.registerEvent(
            this.app.vault.on('modify', (file: TAbstractFile) => {
                if (file instanceof TFile && file.extension === 'md') {
                    this.scheduleIndexUpdate(file);
                }
            })
        );

        this.registerEvent(
            this.app.vault.on('create', (file: TAbstractFile) => {
                if (file instanceof TFile && file.extension === 'md') {
                    if (this.app.workspace.layoutReady) {
                        this.scheduleIndexUpdate(file);
                    }
                }
            })
        );

        this.registerEvent(
            this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
                if (file instanceof TFile && file.extension === 'md') {
                    if (this.indexer && this.isStartupComplete) {
                        this.indexer.removeFile(oldPath);
                        this.scheduleIndexUpdate(file);
                    }
                }
            })
        );

        this.registerEvent(
            this.app.vault.on('delete', (file: TAbstractFile) => {
                if (file instanceof TFile && file.extension === 'md') {
                    if (this.indexer && this.isStartupComplete) {
                        this.indexer.removeFile(file.path);
                        this.refreshConcordanceView();
                        this.refreshSettings();
                    }
                }
            })
        );

        // Context menu - editor mode
        this.registerEvent(
            this.app.workspace.on('editor-menu', (menu, editor) => {
                const cursor = editor.getCursor();
                const line = editor.getLine(cursor.line);
                let hasReference = false;
                let matchedEntry: any = null;

                if (isEngineReady()) {
                    const activeFile = this.app.workspace.getActiveFile();
                    const sourceLang = this.getEffectiveSourceLanguage(activeFile);
                    const processedLine = this.transformForcedReferences(line);
                    const parsed = parseReferences(
                        processedLine,
                        sourceLang,
                        this.settings.outputLanguage,
                        this.settings.nameFormat
                    );

                    if (parsed && parsed.length > 0) {
                        const cursorCh = cursor.ch;
                        for (const entry of parsed) {
                            const startPos = entry[1] as number;
                            const endPos = entry[2] as number;
                            if (cursorCh > startPos && cursorCh < endPos) {
                                hasReference = true;
                                matchedEntry = entry;
                                break;
                            }
                        }
                    }
                }

                menu.addItem((item: any) => {
                    item.setTitle('con[VER]sum').setIcon('book-open');
                    const submenu = item.setSubmenu();
                    submenu.addItem((subItem: any) => {
                        subItem.setTitle('Open concordance').setIcon('book-open');
                        subItem.onClick(() => {
                            this.openConcordanceView();
                        });
                    });
                    if (hasReference && matchedEntry) {
                        submenu.addItem((subItem: any) => {
                            subItem.setTitle('Find related notes').setIcon('link');
                            subItem.onClick(() => {
                                this.showRelatedNotesFromParsed([matchedEntry]);
                            });
                        });
                    }
                });
            })
        );

        // Context menu - reading mode
        this.registerDomEvent(activeDocument, 'contextmenu', (evt: MouseEvent) => {
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (!view || view.getMode() !== 'preview') return;
            const activeFile = this.app.workspace.getActiveFile();
            const sourceLang = this.getEffectiveSourceLanguage(activeFile);
            let parsed: any[] | null = null;
            const selection = activeDocument.getSelection()?.toString() || '';
            if (selection) {
                const processedText = this.transformForcedReferences(selection);
                parsed = parseReferences(processedText, sourceLang, this.settings.outputLanguage, this.settings.nameFormat);
                if (parsed && parsed.length > 0) {
                    this.showReadingModeMenu(evt, parsed);
                    return;
                }
            }
            const element = activeDocument.elementFromPoint(evt.clientX, evt.clientY);
            if (!element) {
                this.showReadingModeMenu(evt, null);
                return;
            }
            const range = activeDocument.caretRangeFromPoint(evt.clientX, evt.clientY);
            let isAtEnd = false;
            if (range) {
                const container = range.startContainer;
                if (container.nodeType === Node.TEXT_NODE) {
                    const textNode = container as Text;
                    const text = textNode.textContent || '';
                    const offset = range.startOffset;
                    if (offset >= text.length) {
                        let nextSibling = textNode.nextSibling;
                        let hasTextAfter = false;
                        while (nextSibling) {
                            if (nextSibling.nodeType === Node.TEXT_NODE) {
                                const siblingText = (nextSibling as Text).textContent || '';
                                if (siblingText.trim().length > 0) {
                                    hasTextAfter = true;
                                    break;
                                }
                            } else if (nextSibling.nodeType === Node.ELEMENT_NODE) {
                                const elementText = (nextSibling as Element).textContent || '';
                                if (elementText.trim().length > 0) {
                                    hasTextAfter = true;
                                    break;
                                }
                            }
                            nextSibling = nextSibling.nextSibling;
                        }
                        if (!hasTextAfter) {
                            isAtEnd = true;
                        }
                    }
                }
            }
            if (isAtEnd) {
                this.showReadingModeMenu(evt, null);
                return;
            }
            let textToParse = '';
            const linkEl = element.closest('a');
            if (linkEl) {
                const dataBcv = linkEl.getAttribute('data-bcv');
                const linkText = linkEl.textContent || '';
                if (dataBcv) {
                    const rangeKey = `${dataBcv}-${dataBcv}`;
                    const entry = this.indexer?.getReference(rangeKey);
                    if (entry) {
                        const refData = [[linkText, 0, linkText.length, [[dataBcv, dataBcv]]]];
                        this.showReadingModeMenu(evt, refData as any[]);
                    } else {
                        this.showReadingModeMenu(evt, null);
                    }
                    return;
                }
                const parent = linkEl.parentElement;
                if (parent) {
                    const parentText = parent.textContent || '';
                    const forceMatch = parentText.match(/\{\{(.+?)\}\}/);
                    if (forceMatch) {
                        textToParse = forceMatch[0];
                    } else {
                        textToParse = linkText;
                    }
                } else {
                    textToParse = linkText;
                }
            } else {
                if (range && range.startContainer) {
                    const container = range.startContainer;
                    if (container.nodeType === Node.TEXT_NODE) {
                        const textNode = container as Text;
                        const fullText = textNode.textContent || '';
                        const forceMatch = fullText.match(/\{\{(.+?)\}\}/);
                        if (forceMatch) {
                            textToParse = forceMatch[0];
                        } else {
                            textToParse = fullText;
                        }
                    }
                }
            }
            if (textToParse && !textToParse.includes('{{')) {
                const clickedText = textToParse.trim();
                if (clickedText.length === 0) {
                    const parentElement = element.closest('p, div, span, a');
                    if (parentElement) {
                        const fullText = parentElement.textContent || '';
                        const forceMatch = fullText.match(/\{\{(.+?)\}\}/);
                        if (forceMatch) {
                            textToParse = forceMatch[0];
                        }
                    }
                }
            }
            if (textToParse) {
                const processedText = this.transformForcedReferences(textToParse);
                const parsedResult = parseReferences(processedText, sourceLang, this.settings.outputLanguage, this.settings.nameFormat);
                if (parsedResult && parsedResult.length > 0) {
                    const refText = parsedResult[0][0] as string;
                    const contextText = element.textContent || '';
                    const parentText = element.parentElement?.textContent || '';
                    const fullContext = parentText || contextText;
                    if (fullContext.includes(refText) || textToParse.includes(refText)) {
                        parsed = parsedResult;
                    }
                }
            }
            this.showReadingModeMenu(evt, parsed);
        });
    }

    private showReadingModeMenu(evt: MouseEvent, parsed: any[] | null): void {
        evt.preventDefault();
        evt.stopPropagation();
        const menu = new Menu();
        menu.addItem((item: any) => {
            item.setTitle('con[VER]sum').setIcon('book-open');
            const submenu = item.setSubmenu();
            submenu.addItem((subItem: any) => {
                subItem.setTitle('Open concordance').setIcon('book-open');
                subItem.onClick(() => {
                    this.openConcordanceView();
                });
            });
            if (parsed && parsed.length > 0) {
                const range = activeDocument.caretRangeFromPoint(evt.clientX, evt.clientY);
                let isOnRef = false;
                if (range) {
                    const node = range.startContainer;
                    if (node.nodeType === Node.TEXT_NODE) {
                        const text = (node as Text).textContent || '';
                        const offset = range.startOffset;
                        const refText = parsed[0][0] as string;
                        const cleanText = text.replace(/\{\{|\}\}/g, '');
                        if (cleanText.includes(refText)) {
                            const startIdx = cleanText.indexOf(refText);
                            const endIdx = startIdx + refText.length;
                            const beforeRef = text.substring(0, text.indexOf(refText));
                            const markerOffset = (beforeRef.match(/\{\{/g) || []).length * 2;
                            const cleanOffset = offset - markerOffset;
                            if (cleanOffset >= startIdx && cleanOffset < endIdx) {
                                isOnRef = true;
                            }
                        }
                    } else {
                        const parent = node.parentElement;
                        if (parent) {
                            const text = parent.textContent || '';
                            const refText = parsed[0][0] as string;
                            if (text.includes(refText)) {
                                isOnRef = true;
                            }
                        }
                    }
                }
                if (isOnRef) {
                    submenu.addItem((subItem: any) => {
                        subItem.setTitle('Find related notes').setIcon('link');
                        subItem.onClick(() => {
                            this.showRelatedNotesFromParsed(parsed);
                        });
                    });
                }
            }
        });
        menu.showAtPosition({ x: evt.clientX, y: evt.clientY - 70 });
    }

    // ============================================================
    // COMMANDS
    // ============================================================

    private addCommands(): void {
        this.addCommand({
            id: 'find-related-notes',
            name: 'Find related notes',
            icon: 'link',
            editorCallback: (editor: Editor) => {
                const cursor = editor.getCursor();
                const line = editor.getLine(cursor.line);
                this.findRelatedNotesAtCursor(editor, cursor, line);
            }
        });
        this.addCommand({
            id: 'open-concordance',
            name: 'Open concordance',
            icon: 'book-open',
            callback: () => this.openConcordanceView()
        });
        this.addCommand({
            id: 'stop-indexing',
            name: 'Stop indexing',
            icon: 'square',
            callback: () => {
                if (this.indexer?.isBusy()) {
                    this.indexer.abort();
                    new Notice('Stopping index rebuild...');
                } else {
                    new Notice('No indexing in progress');
                }
            }
        });
        this.addCommand({
            id: 'reformat-all-references',
            name: 'Reformat all references',
            icon: 'text-cursor-input',
            callback: async () => {
                if (this.indexer?.isBusy()) {
                    new Notice('Indexing or formatting is in progress. Wait for it to finish, then try again.');
                    return;
                }
                await this.reformatAllReferences();
                new Notice('Reformatting started in the background.');
            }
        });
    }

    // ============================================================
    // VIEW MANAGEMENT
    // ============================================================

    async openConcordanceView(): Promise<void> {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(VIEW_TYPE_CONVERSUM_CONCORDANCE)[0];
        if (!leaf) {
            const rightLeaf = workspace.getRightLeaf(false);
            if (!rightLeaf) {
                new Notice('Could not create view');
                return;
            }
            await rightLeaf.setViewState({
                type: VIEW_TYPE_CONVERSUM_CONCORDANCE,
                active: true
            });
            leaf = rightLeaf;
        }
        await workspace.revealLeaf(leaf);
    }

    public refreshConcordanceView(): void {
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CONVERSUM_CONCORDANCE);
        for (const leaf of leaves) {
            const view = leaf.view as ConcordanceView;
            if (view && typeof view.refresh === 'function') {
                view.refresh();
            }
        }
    }

    public refreshSettings(): void {
        if (this.settingsTab) {
            if (this.settingsTab.containerEl && this.settingsTab.containerEl.children.length > 0) {
                this.settingsTab.display();
                return;
            }
        }
        const settingTabs = (this.app as any).setting?.tabContainer?.children;
        if (settingTabs) {
            for (const child of settingTabs) {
                if (child.textContent?.includes('con[VER]sum')) {
                    const tab = child as any;
                    if (tab && typeof tab.display === 'function') {
                        tab.display();
                    }
                    break;
                }
            }
        }
    }

    // ============================================================
    // EFFECTIVE SOURCE LANGUAGE
    // ============================================================

    private getEffectiveSourceLanguage(file: TFile | null): string {
        if (!file || !this.db) return this.settings.sourceLanguage;
        const language = this.db.getFileLanguage(file.path);
        return language || this.settings.sourceLanguage;
    }

    // ============================================================
    // FIND REFERENCE AT CURSOR
    // ============================================================

    private findReferenceAtPosition(line: string, position: number, sourceLang: string): { text: string; startBcv: string; endBcv: string } | null {
        if (!isEngineReady()) return null;
        const processedLine = this.transformForcedReferences(line);
        const parsed = parseReferences(
            processedLine,
            sourceLang,
            this.settings.outputLanguage,
            this.settings.nameFormat
        );
        if (!parsed || parsed.length === 0) {
            return null;
        }
        for (const entry of parsed) {
            const startPos = entry[1] as number;
            const endPos = entry[2] as number;
            const matchedText = entry[0] as string;
            const ranges = entry[3] as string[][];
            if (position >= startPos && position < endPos) {
                if (ranges && ranges.length > 0) {
                    return {
                        text: matchedText,
                        startBcv: ranges[0][0],
                        endBcv: ranges[0][1]
                    };
                }
            }
        }
        return null;
    }

    private showRelatedNotesFromParsed(parsed: any[], evt?: MouseEvent): void {
        if (!parsed || parsed.length === 0) {
            const activeFile = this.app.workspace.getActiveFile();
            const sourceLang = this.getEffectiveSourceLanguage(activeFile);
            const langName = getAvailableLanguages().find(l => l.language_code === sourceLang)?.language_name || sourceLang;
            new Notice(`No scripture reference found in ${langName}`);
            return;
        }
        
        const ranges = parsed[0][3] as string[][];
        if (!ranges || ranges.length === 0) {
            const activeFile = this.app.workspace.getActiveFile();
            const sourceLang = this.getEffectiveSourceLanguage(activeFile);
            const langName = getAvailableLanguages().find(l => l.language_code === sourceLang)?.language_name || sourceLang;
            new Notice(`No valid reference found in ${langName}`);
            return;
        }

        const startBcv = ranges[0][0];
        const endBcv = ranges[0][1];
        if (!startBcv || startBcv.length < 8) {
            const activeFile = this.app.workspace.getActiveFile();
            const sourceLang = this.getEffectiveSourceLanguage(activeFile);
            const langName = getAvailableLanguages().find(l => l.language_code === sourceLang)?.language_name || sourceLang;
            new Notice(`Invalid reference format in ${langName}`);
            return;
        }

        const matchingEntries = this.indexer?.findReferencesContainingRange(startBcv, endBcv) || [];
        if (matchingEntries.length === 0) {
            const activeFile = this.app.workspace.getActiveFile();
            const sourceLang = this.getEffectiveSourceLanguage(activeFile);
            const langName = getAvailableLanguages().find(l => l.language_code === sourceLang)?.language_name || sourceLang;
            new Notice(`No notes found for this reference in ${langName}`);
            return;
        }

        const firstEntry = matchingEntries[0][1];
        const formatted = this.formatReferenceOnTheFly(firstEntry);
        if (evt) {
            this.relatedPopout?.showWithEntries(startBcv, formatted, matchingEntries, evt.clientX, evt.clientY);
        } else {
            this.relatedPopout?.showWithEntries(startBcv, formatted, matchingEntries, window.innerWidth / 2 - 150, window.innerHeight / 2 - 100);
        }
    }

    private findRelatedNotesAtCursor(editor: Editor, cursor: EditorPosition, line: string): void {
        if (!isEngineReady()) {
            new Notice('Engine not ready');
            return;
        }
        if (!this.indexer) {
            new Notice('Indexer not initialized');
            return;
        }

        const activeFile = this.app.workspace.getActiveFile();
        const sourceLang = this.getEffectiveSourceLanguage(activeFile);
        const result = this.findReferenceAtPosition(line, cursor.ch, sourceLang);
        if (!result) {
            const wordMatch = line.substring(0, cursor.ch).match(/\S+$/);
            const nextWordMatch = line.substring(cursor.ch).match(/^\S+/);
            const word = wordMatch ? wordMatch[0] : (nextWordMatch ? nextWordMatch[0] : null);
            if (word) {
                new Notice(`"${word}" is not a scripture reference`);
            } else {
                new Notice('No scripture reference found at cursor');
            }
            return;
        }

        const { text: reference, startBcv, endBcv } = result;
        if (!startBcv || startBcv.length < 8) {
            new Notice('Invalid reference format');
            return;
        }
        const matchingEntries = this.indexer.findReferencesContainingRange(startBcv, endBcv);
        if (matchingEntries.length === 0) {
            const langName = getAvailableLanguages().find(l => l.code === sourceLang)?.vernacularName || sourceLang;
            new Notice(`No notes found for "${reference}" in ${langName}`);
            return;
        }

        const firstEntry = matchingEntries[0][1];
        const formatted = this.formatReferenceOnTheFly(firstEntry);
        let x = 0, y = 0;
        try {
            const editorView = (editor as any).cm?.view || (editor as any).cm;
            if (editorView && typeof editorView.coordsAtPos === 'function') {
                const pos = editorView.posAtCoords({ line: cursor.line, ch: cursor.ch });
                if (pos !== null && pos !== undefined) {
                    const coords = editorView.coordsAtPos(pos);
                    if (coords) {
                        x = coords.left || 0;
                        y = (coords.top || 0) + 25;
                    }
                }
            }
        } catch { }

        if (x === 0 && y === 0) {
            const activeEl = activeDocument.activeElement;
            if (activeEl) {
                const rect = activeEl.getBoundingClientRect();
                x = rect.left + 20;
                y = rect.top + 40;
            }
        }
        if (x === 0 && y === 0) {
            x = window.innerWidth / 2 - 150;
            y = window.innerHeight / 2 - 100;
        }
        this.relatedPopout?.showWithEntries(startBcv, formatted, matchingEntries, x, y);
    }

    // ============================================================
    // EXPORT
    // ============================================================

    async exportConcordance(): Promise<void> {
        if (!this.indexer) {
            new Notice('Indexer not initialized');
            return;
        }
        const data = this.indexer.getData();
        if (!data || Object.keys(data.references).length === 0) {
            new Notice('No references to export');
            return;
        }
        try {
            const content = this.generateConcordanceContent(data);
            const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, '');
            const fileName = `Concordance-${timestamp}.md`;
            const filePath = `/${fileName}`;
            const file = await this.app.vault.create(filePath, content);
            await this.app.workspace.openLinkText(file.path, '');
            new Notice(`Concordance exported: ${fileName}`);
        } catch (e) {
            await this.logger?.error('Export concordance failed', e);
            new Notice('Export failed. See console or log for details.');
        }
    }

    private generateConcordanceContent(data: any): string {
        const lines: string[] = [];
        const vaultName = this.app.vault.getName();
        lines.push(`# ${vaultName} — Scripture Concordance`);
        lines.push('');
        lines.push(`Generated: ${new Date().toLocaleString()}`);
        lines.push(`Unique references: ${Object.keys(data.references).length}`);
        lines.push(`Files indexed: ${Object.keys(data.fileCache).length}`);
        lines.push('');
        lines.push('---');

        const grouped = this.indexer!.getGroupedReferences();
        for (const [bookId, chapterMap] of grouped) {
            const bookName = getBookName(
                bookId,
                this.settings.outputLanguage,
                'full'
            );
            lines.push(`## ${bookName || `Book ${bookId}`}`);
            lines.push('');
            const allRefs: Array<[string, ReferenceIndexEntry, string | null]> = [];
            for (const [, refs] of chapterMap) {
                for (const ref of refs) {
                    allRefs.push(ref);
                }
            }
            allRefs.sort((a, b) => {
                const aStart = a[0].split('-')[0];
                const bStart = b[0].split('-')[0];
                const aCh = parseInt(aStart.substring(2, 5));
                const bCh = parseInt(bStart.substring(2, 5));
                if (aCh !== bCh) return aCh - bCh;
                return parseInt(aStart.substring(5, 8)) - parseInt(bStart.substring(5, 8));
            });

            for (const [key, entry, formatted] of allRefs) {
                let formattedRef: string;
                if (formatted) {
                    formattedRef = formatted;
                } else {
                    const ranges: Array<[string, string]> = [[
                        `${String(entry.bcv.bookId).padStart(2, '0')}${String(entry.bcv.chapter).padStart(3, '0')}${String(entry.bcv.startVerse).padStart(3, '0')}`,
                        `${String(entry.bcv.bookId).padStart(2, '0')}${String(entry.bcv.endChapter !== undefined && entry.bcv.endChapter !== entry.bcv.chapter ? entry.bcv.endChapter : entry.bcv.chapter).padStart(3, '0')}${String(entry.bcv.endVerse).padStart(3, '0')}`
                    ]];
                    const decoded = decodeScriptures(
                        ranges,
                        this.settings.outputLanguage,
                        this.settings.nameFormat
                    );
                    formattedRef = decoded && decoded.length > 0 ? decoded[0] : `${entry.startBcv}-${entry.endBcv}`;
                }

                const filesWithCounts = this.db?.getFilesWithCounts(key) || [];
                const sortedFiles = filesWithCounts
                    .map(f => ({ path: f.path, occurrences: f.occurrences }))
                    .sort((a, b) => a.path.localeCompare(b.path));
                const fileEntries: string[] = [];
                for (const file of sortedFiles) {
                    const fileName = file.path.replace(/\.md$/, '');
                    fileEntries.push(`[[${fileName}]] (${file.occurrences})`);
                }
                lines.push(`**${formattedRef}** — ${fileEntries.join('; ')}`);
            }
            lines.push('');
            lines.push('---');
        }
        lines.push('---');
        lines.push('');
        lines.push('*Generated by `con[VER]sum v' + this.manifest.version + '`*');
        return lines.join('\n');
    }
}

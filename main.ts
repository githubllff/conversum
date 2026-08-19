// main.ts

import { Plugin, Notice, Menu, TFile, TAbstractFile, Editor, EditorPosition, MarkdownView } from 'obsidian';
import { IndexDatabase } from './database';
import { initEngine, isEngineReady, getAvailableLanguages, parseReferences, getBookName, decodeScriptures, prewarmEngines, clearEnginePool } from './engine';
import { ScriptureIndexer } from './indexer';
import { RelatedNotesPopout } from './related';
import { ConversumSettingTab } from './settings';
import { ConcordanceView } from './sidebar';
import { ConversumSettings, DEFAULT_SETTINGS, VIEW_TYPE_CONVERSUM_CONCORDANCE, IndexProgress, ReferenceIndexEntry } from './types';

export default class ConversumPlugin extends Plugin {
    settings!: ConversumSettings;
    indexer: ScriptureIndexer | null = null;
    private db: IndexDatabase | null = null;
    private rebuildTimeout: number | null = null;
    private fileWatcherEnabled = false;
    private pendingFiles = new Set<TFile>();
    private relatedPopout: RelatedNotesPopout | null = null;
    private isStartupComplete = false;
    public settingsTab: ConversumSettingTab | null = null;

    public getDatabase(): IndexDatabase | null {
        return this.db;
    }

    async onload(): Promise<void> {
        await this.loadSettings();

        try {
            await initEngine();
        } catch (e) {
            console.error('con[VER]sum: Failed to initialize engine:', e);
            new Notice('con[VER]sum: Failed to initialize engine.');
        }
        prewarmEngines(this.settings.sourceLanguage, this.settings.outputLanguage);

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

        const data = this.db.getData();
        const hasValidData = data && 
            data.references && 
            Object.keys(data.references).length > 0;
        const rebuildStatus = this.settings.rebuildStatus || 'unknown';

        if (rebuildStatus === 'in_progress' || rebuildStatus === 'failed' || rebuildStatus === 'aborted') {
            new Notice('Previous index rebuild was incomplete. Rebuilding...');
            this.settings.rebuildStatus = 'in_progress';
            await this.saveSettings();
            this.app.workspace.onLayoutReady(async () => {
                await new Promise(resolve => setTimeout(resolve, 500));
                await this.syncIndexOnStartup();
            });
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
            for (const file of filesToIndex) {
                try {
                    await this.indexer.updateFile(file, true);
                } catch {
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

        try {
            const progressCallback = (progress: IndexProgress) => {
                const percent = progress.totalFiles > 0 
                    ? Math.round((progress.processedFiles / progress.totalFiles) * 100) 
                    : 0;
                const fileInfo = progress.currentFile ? ` (${progress.currentFile})` : '';
                notice.setMessage(`Indexing: ${percent}% (${progress.processedFiles}/${progress.totalFiles} files${fileInfo}, ${progress.uniqueReferences} unique refs)`);
            };

            await this.indexer.rebuildIndex(progressCallback);
            const data = this.indexer.getData();
            notice.setMessage(`Index complete: ${data ? Object.keys(data.references).length : 0} unique references`);
            setTimeout(() => notice.hide(), 2000);
            this.refreshConcordanceView();
            this.refreshSettings();

        } catch {
            notice.setMessage('Index rebuild failed. See console for details.');
            setTimeout(() => notice.hide(), 3000);
        }
    }

    private formatReferenceOnTheFly(entry: ReferenceIndexEntry): string {
        const ranges: Array<[string, string]> = [[entry.startBcv, entry.endBcv]];
        const decoded = decodeScriptures(
            ranges,
            this.settings.outputLanguage,
            this.settings.nameFormat
        );
        return decoded && decoded.length > 0 && decoded[0] ? decoded[0] : `${entry.startBcv}-${entry.endBcv}`;\n    }\n\n    public async reformatAllReferences(): Promise<void> {\n        if (!this.indexer) return;\n        const data = this.indexer.getData();\n        if (!data || Object.keys(data.references).length === 0) return;\n        await this.indexer.clearFormatted();\n        this.indexer.startBackgroundFormatting();\n        this.refreshConcordanceView();\n        this.refreshSettings();\n    }\n\n    // ============================================================\n    // FILE WATCHER\n    // ============================================================\n\n    startFileWatcher(): void {\n        if (this.fileWatcherEnabled) return;\n        this.fileWatcherEnabled = true;\n    }\n\n    stopFileWatcher(): void {\n        this.fileWatcherEnabled = false;\n        this.pendingFiles.clear();\n        if (this.rebuildTimeout) {\n            clearTimeout(this.rebuildTimeout);\n            this.rebuildTimeout = null;\n        }\n    }\n\n    private scheduleIndexUpdate(file: TFile): void {\n        if (!this.settings.autoIndex || !this.fileWatcherEnabled) return;\n        if (!this.indexer) return;\n        if (this.indexer.isExcluded(file.path)) return;\n\n        this.pendingFiles.add(file);\n\n        if (this.rebuildTimeout) {\n            clearTimeout(this.rebuildTimeout);\n        }\n\n        this.rebuildTimeout = window.setTimeout(async () => {\n            this.rebuildTimeout = null;\n            if (!this.indexer || this.indexer.isIndexingBusy()) return;\n            const filesToProcess = Array.from(this.pendingFiles);\n            this.pendingFiles.clear();\n\n            for (const f of filesToProcess) {\n                try {\n                    await this.indexer.updateFile(f, true);\n                } catch (e) {\n                    console.error(`con[VER]sum: Failed to update file ${f.path}:`, e);\n                }\n            }\n            this.indexer.startBackgroundFormatting();\n            this.refreshConcordanceView();\n            this.refreshSettings();\n        }, 1500);\n    }\n\n    // ============================================================\n    // EVENTS\n    // ============================================================\n\n    private registerEvents(): void {\n        this.registerEvent(\n            this.app.vault.on('modify', (file: TAbstractFile) => {\n                if (file instanceof TFile && file.extension === 'md') {\n                    this.scheduleIndexUpdate(file);\n                }\n            })\n        );\n\n        this.registerEvent(\n            this.app.vault.on('create', (file: TAbstractFile) => {\n                if (file instanceof TFile && file.extension === 'md') {\n                    if (this.app.workspace.layoutReady) {\n                        this.scheduleIndexUpdate(file);\n                    }\n                }\n            })\n        );\n\n        this.registerEvent(\n            this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {\n                if (file instanceof TFile && file.extension === 'md') {\n                    if (this.indexer && this.isStartupComplete) {\n                        this.indexer.removeFile(oldPath);\n                        this.scheduleIndexUpdate(file);\n                    }\n                }\n            })\n        );\n\n        this.registerEvent(\n            this.app.vault.on('delete', (file: TAbstractFile) => {\n                if (file instanceof TFile && file.extension === 'md') {\n                    if (this.indexer && this.isStartupComplete) {\n                        this.indexer.removeFile(file.path);\n                        this.refreshConcordanceView();\n                        this.refreshSettings();\n                    }\n                }\n            })\n        );\n\n        // Context menu - editor mode\n        this.registerEvent(\n            this.app.workspace.on('editor-menu', (menu, editor) => {\n                const cursor = editor.getCursor();\n                const line = editor.getLine(cursor.line);\n                let hasReference = false;\n                let matchedEntry: any = null;\n\n                if (isEngineReady()) {\n                    const activeFile = this.app.workspace.getActiveFile();\n                    const sourceLang = this.getEffectiveSourceLanguage(activeFile);\n                    const processedLine = this.transformForcedReferences(line);\n                    const parsed = parseReferences(\n                        processedLine,\n                        sourceLang,\n                        this.settings.outputLanguage,\n                        this.settings.nameFormat\n                    );\n\n                    if (parsed && parsed.length > 0) {\n                        const cursorCh = cursor.ch;\n                        for (const entry of parsed) {\n                            const startPos = entry[1] as number;\n                            const endPos = entry[2] as number;\n                            if (cursorCh > startPos && cursorCh < endPos) {\n                                hasReference = true;\n                                matchedEntry = entry;\n                                break;\n                            }\n                        }\n                    }\n                }\n\n                menu.addItem((item: any) => {\n                    item.setTitle('con[VER]sum').setIcon('book-open');\n                    const submenu = item.setSubmenu();\n                    submenu.addItem((subItem: any) => {\n                        subItem.setTitle('Open concordance').setIcon('book-open');\n                        subItem.onClick(() => {\n                            this.openConcordanceView();\n                        });\n                    });\n                    if (hasReference && matchedEntry) {\n                        submenu.addItem((subItem: any) => {\n                            subItem.setTitle('Find related notes').setIcon('link');\n                            subItem.onClick(() => {\n                                this.showRelatedNotesFromParsed([matchedEntry]);\n                            });\n                        });\n                    }\n                });\n            })\n        );\n\n        // Context menu - reading mode\n        this.registerDomEvent(activeDocument, 'contextmenu', (evt: MouseEvent) => {\n            const view = this.app.workspace.getActiveViewOfType(MarkdownView);\n            if (!view || view.getMode() !== 'preview') return;\n            const activeFile = this.app.workspace.getActiveFile();\n            const sourceLang = this.getEffectiveSourceLanguage(activeFile);\n            let parsed: any[] | null = null;\n            const selection = activeDocument.getSelection()?.toString() || '';\n            if (selection) {\n                const processedText = this.transformForcedReferences(selection);\n                parsed = parseReferences(processedText, sourceLang, this.settings.outputLanguage, this.settings.nameFormat);\n                if (parsed && parsed.length > 0) {\n                    this.showReadingModeMenu(evt, parsed);\n                    return;\n                }\n            }\n            const element = activeDocument.elementFromPoint(evt.clientX, evt.clientY);\n            if (!element) {\n                this.showReadingModeMenu(evt, null);\n                return;\n            }\n            const range = activeDocument.caretRangeFromPoint(evt.clientX, evt.clientY);\n            let isAtEnd = false;\n            if (range) {\n                const container = range.startContainer;\n                if (container.nodeType === Node.TEXT_NODE) {\n                    const textNode = container as Text;\n                    const text = textNode.textContent || '';\n                    const offset = range.startOffset;\n                    if (offset >= text.length) {\n                        let nextSibling = textNode.nextSibling;\n                        let hasTextAfter = false;\n                        while (nextSibling) {\n                            if (nextSibling.nodeType === Node.TEXT_NODE) {\n                                const siblingText = (nextSibling as Text).textContent || '';\n                                if (siblingText.trim().length > 0) {\n                                    hasTextAfter = true;\n                                    break;\n                                }\n                            } else if (nextSibling.nodeType === Node.ELEMENT_NODE) {\n                                const elementText = (nextSibling as Element).textContent || '';\n                                if (elementText.trim().length > 0) {\n                                    hasTextAfter = true;\n                                    break;\n                                }\n                            }\n                            nextSibling = nextSibling.nextSibling;\n                        }\n                        if (!hasTextAfter) {\n                            isAtEnd = true;\n                        }\n                    }\n                }\n            }\n            if (isAtEnd) {\n                this.showReadingModeMenu(evt, null);\n                return;\n            }\n            let textToParse = '';\n            const linkEl = element.closest('a');\n            if (linkEl) {\n                const dataBcv = linkEl.getAttribute('data-bcv');\n                const linkText = linkEl.textContent || '';\n                if (dataBcv) {\n                    const rangeKey = `${dataBcv}-${dataBcv}`;\n                    const entry = this.indexer?.getReference(rangeKey);\n                    if (entry) {\n                        const refData = [[linkText, 0, linkText.length, [[dataBcv, dataBcv]]]];\n                        this.showReadingModeMenu(evt, refData as any[]);\n                    } else {\n                        this.showReadingModeMenu(evt, null);\n                    }\n                    return;\n                }\n                const parent = linkEl.parentElement;\n                if (parent) {\n                    const parentText = parent.textContent || '';\n                    const forceMatch = parentText.match(/\\{\\{(.+?)\\}\\}/);\n                    if (forceMatch) {\n                        textToParse = forceMatch[0];\n                    } else {\n                        textToParse = linkText;\n                    }\n                } else {\n                    textToParse = linkText;\n                }\n            } else {\n                if (range && range.startContainer) {\n                    const container = range.startContainer;\n                    if (container.nodeType === Node.TEXT_NODE) {\n                        const textNode = container as Text;\n                        const fullText = textNode.textContent || '';\n                        const forceMatch = fullText.match(/\\{\\{(.+?)\\}\\}/);\n                        if (forceMatch) {\n                            textToParse = forceMatch[0];\n                        } else {\n                            textToParse = fullText;\n                        }\n                    }\n                }\n            }\n            if (textToParse && !textToParse.includes('{{')) {\n                const clickedText = textToParse.trim();\n                if (clickedText.length === 0) {\n                    const parentElement = element.closest('p, div, span, a');\n                    if (parentElement) {\n                        const fullText = parentElement.textContent || '';\n                        const forceMatch = fullText.match(/\\{\\{(.+?)\\}\\}/);\n                        if (forceMatch) {\n                            textToParse = forceMatch[0];\n                        }\n                    }\n                }\n            }\n            if (textToParse) {\n                const processedText = this.transformForcedReferences(textToParse);\n                const parsedResult = parseReferences(processedText, sourceLang, this.settings.outputLanguage, this.settings.nameFormat);\n                if (parsedResult && parsedResult.length > 0) {\n                    const refText = parsedResult[0][0] as string;\n                    const contextText = element.textContent || '';\n                    const parentText = element.parentElement?.textContent || '';\n                    const fullContext = parentText || contextText;\n                    if (fullContext.includes(refText) || textToParse.includes(refText)) {\n                        parsed = parsedResult;\n                    }\n                }\n            }\n            this.showReadingModeMenu(evt, parsed);\n        });\n    }\n\n    private showReadingModeMenu(evt: MouseEvent, parsed: any[] | null): void {\n        evt.preventDefault();\n        evt.stopPropagation();\n        const menu = new Menu();\n        menu.addItem((item: any) => {\n            item.setTitle('con[VER]sum').setIcon('book-open');\n            const submenu = item.setSubmenu();\n            submenu.addItem((subItem: any) => {\n                subItem.setTitle('Open concordance').setIcon('book-open');\n                subItem.onClick(() => {\n                    this.openConcordanceView();\n                });\n            });\n            if (parsed && parsed.length > 0) {\n                const range = activeDocument.caretRangeFromPoint(evt.clientX, evt.clientY);\n                let isOnRef = false;\n                if (range) {\n                    const node = range.startContainer;\n                    if (node.nodeType === Node.TEXT_NODE) {\n                        const text = (node as Text).textContent || '';\n                        const offset = range.startOffset;\n                        const refText = parsed[0][0] as string;\n                        const cleanText = text.replace(/\\{\\{|\\}\\}/g, '');\n                        if (cleanText.includes(refText)) {\n                            const startIdx = cleanText.indexOf(refText);\n                            const endIdx = startIdx + refText.length;\n                            const beforeRef = text.substring(0, text.indexOf(refText));\n                            const markerOffset = (beforeRef.match(/\\{\\{/g) || []).length * 2;\n                            const cleanOffset = offset - markerOffset;\n                            if (cleanOffset >= startIdx && cleanOffset < endIdx) {\n                                isOnRef = true;\n                            }\n                        }\n                    } else {\n                        const parent = node.parentElement;\n                        if (parent) {\n                            const text = parent.textContent || '';\n                            const refText = parsed[0][0] as string;\n                            if (text.includes(refText)) {\n                                isOnRef = true;\n                            }\n                        }\n                    }\n                }\n                if (isOnRef) {\n                    submenu.addItem((subItem: any) => {\n                        subItem.setTitle('Find related notes').setIcon('link');\n                        subItem.onClick(() => {\n                            this.showRelatedNotesFromParsed(parsed);\n                        });\n                    });\n                }\n            }\n        });\n        menu.showAtPosition({ x: evt.clientX, y: evt.clientY - 70 });\n    }\n\n    // ============================================================\n    // COMMANDS\n    // ============================================================\n\n    private addCommands(): void {\n        this.addCommand({\n            id: 'find-related-notes',\n            name: 'Find related notes',\n            icon: 'link',\n            editorCallback: (editor: Editor) => {\n                const cursor = editor.getCursor();\n                const line = editor.getLine(cursor.line);\n                this.findRelatedNotesAtCursor(editor, cursor, line);\n            }\n        });\n        this.addCommand({\n            id: 'open-concordance',\n            name: 'Open concordance',\n            icon: 'book-open',\n            callback: () => this.openConcordanceView()\n        });\n    }\n\n    // ============================================================\n    // VIEW MANAGEMENT\n    // ============================================================\n\n    async openConcordanceView(): Promise<void> {\n        const { workspace } = this.app;\n        let leaf = workspace.getLeavesOfType(VIEW_TYPE_CONVERSUM_CONCORDANCE)[0];\n        if (!leaf) {\n            const rightLeaf = workspace.getRightLeaf(false);\n            if (!rightLeaf) {\n                new Notice('Could not create view');\n                return;\n            }\n            await rightLeaf.setViewState({\n                type: VIEW_TYPE_CONVERSUM_CONCORDANCE,\n                active: true\n            });\n            leaf = rightLeaf;\n        }\n        await workspace.revealLeaf(leaf);\n    }\n\n    public refreshConcordanceView(): void {\n        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CONVERSUM_CONCORDANCE);\n        for (const leaf of leaves) {\n            const view = leaf.view as ConcordanceView;\n            if (view && typeof view.refresh === 'function') {\n                view.refresh();\n            }\n        }\n    }\n\n    public refreshSettings(): void {\n        if (this.settingsTab) {\n            if (this.settingsTab.containerEl && this.settingsTab.containerEl.children.length > 0) {\n                this.settingsTab.display();\n                return;\n            }\n        }\n        const settingTabs = (this.app as any).setting?.tabContainer?.children;\n        if (settingTabs) {\n            for (const child of settingTabs) {\n                if (child.textContent?.includes('con[VER]sum')) {\n                    const tab = child as any;\n                    if (tab && typeof tab.display === 'function') {\n                        tab.display();\n                    }\n                    break;\n                }\n            }\n        }\n    }\n\n    // ============================================================\n    // EFFECTIVE SOURCE LANGUAGE\n    // ============================================================\n\n    private getEffectiveSourceLanguage(file: TFile | null): string {\n        if (!file || !this.db) return this.settings.sourceLanguage;\n        const language = this.db.getFileLanguage(file.path);\n        return language || this.settings.sourceLanguage;\n    }\n\n    // ============================================================\n    // FIND REFERENCE AT CURSOR\n    // ============================================================\n\n    private findReferenceAtPosition(line: string, position: number, sourceLang: string): { text: string; startBcv: string; endBcv: string } | null {\n        if (!isEngineReady()) return null;\n        const processedLine = this.transformForcedReferences(line);\n        const parsed = parseReferences(\n            processedLine,\n            sourceLang,\n            this.settings.outputLanguage,\n            this.settings.nameFormat\n        );\n        if (!parsed || parsed.length === 0) {\n            return null;\n        }\n        for (const entry of parsed) {\n            const startPos = entry[1] as number;\n            const endPos = entry[2] as number;\n            const matchedText = entry[0] as string;\n            const ranges = entry[3] as string[][];\n            if (position >= startPos && position < endPos) {\n                if (ranges && ranges.length > 0) {\n                    return {\n                        text: matchedText,\n                        startBcv: ranges[0][0],\n                        endBcv: ranges[0][1]\n                    };\n                }\n            }\n        }\n        return null;\n    }\n\n    private showRelatedNotesFromParsed(parsed: any[], evt?: MouseEvent): void {\n        if (!parsed || parsed.length === 0) {\n            const activeFile = this.app.workspace.getActiveFile();\n            const sourceLang = this.getEffectiveSourceLanguage(activeFile);\n            const langName = getAvailableLanguages().find(l => l.language_code === sourceLang)?.language_name || sourceLang;\n            new Notice(`No scripture reference found in ${langName}`);\n            return;\n        }\n        \n        const ranges = parsed[0][3] as string[][];\n        if (!ranges || ranges.length === 0) {\n            const activeFile = this.app.workspace.getActiveFile();\n            const sourceLang = this.getEffectiveSourceLanguage(activeFile);\n            const langName = getAvailableLanguages().find(l => l.language_code === sourceLang)?.language_name || sourceLang;\n            new Notice(`No valid reference found in ${langName}`);\n            return;\n        }\n\n        const startBcv = ranges[0][0];\n        const endBcv = ranges[0][1];\n        if (!startBcv || startBcv.length < 8) {\n            const activeFile = this.app.workspace.getActiveFile();\n            const sourceLang = this.getEffectiveSourceLanguage(activeFile);\n            const langName = getAvailableLanguages().find(l => l.language_code === sourceLang)?.language_name || sourceLang;\n            new Notice(`Invalid reference format in ${langName}`);\n            return;\n        }\n\n        const matchingEntries = this.indexer?.findReferencesContainingRange(startBcv, endBcv) || [];\n        if (matchingEntries.length === 0) {\n            const activeFile = this.app.workspace.getActiveFile();\n            const sourceLang = this.getEffectiveSourceLanguage(activeFile);\n            const langName = getAvailableLanguages().find(l => l.language_code === sourceLang)?.language_name || sourceLang;\n            new Notice(`No notes found for this reference in ${langName}`);\n            return;\n        }\n\n        const firstEntry = matchingEntries[0][1];\n        const formatted = this.formatReferenceOnTheFly(firstEntry);\n        if (evt) {\n            this.relatedPopout?.showWithEntries(startBcv, formatted, matchingEntries, evt.clientX, evt.clientY);\n        } else {\n            this.relatedPopout?.showWithEntries(startBcv, formatted, matchingEntries, window.innerWidth / 2 - 150, window.innerHeight / 2 - 100);\n        }\n    }\n\n    private findRelatedNotesAtCursor(editor: Editor, cursor: EditorPosition, line: string): void {\n        if (!isEngineReady()) {\n            new Notice('Engine not ready');\n            return;\n        }\n        if (!this.indexer) {\n            new Notice('Indexer not initialized');\n            return;\n        }\n\n        const activeFile = this.app.workspace.getActiveFile();\n        const sourceLang = this.getEffectiveSourceLanguage(activeFile);\n        const result = this.findReferenceAtPosition(line, cursor.ch, sourceLang);\n        if (!result) {\n            const wordMatch = line.substring(0, cursor.ch).match(/\\S+$/);\n            const nextWordMatch = line.substring(cursor.ch).match(/^\\S+/);\n            const word = wordMatch ? wordMatch[0] : (nextWordMatch ? nextWordMatch[0] : null);\n            if (word) {\n                new Notice(`\"${word}\" is not a scripture reference`);\n            } else {\n                new Notice('No scripture reference found at cursor');\n            }\n            return;\n        }\n\n        const { text: reference, startBcv, endBcv } = result;\n        if (!startBcv || startBcv.length < 8) {\n            new Notice('Invalid reference format');\n            return;\n        }\n        const matchingEntries = this.indexer.findReferencesContainingRange(startBcv, endBcv);\n        if (matchingEntries.length === 0) {\n            const langName = getAvailableLanguages().find(l => l.code === sourceLang)?.vernacularName || sourceLang;\n            new Notice(`No notes found for \"${reference}\" in ${langName}`);\n            return;\n        }\n\n        const firstEntry = matchingEntries[0][1];\n        const formatted = this.formatReferenceOnTheFly(firstEntry);\n        let x = 0, y = 0;\n        try {\n            const editorView = (editor as any).cm?.view || (editor as any).cm;\n            if (editorView && typeof editorView.coordsAtPos === 'function') {\n                const pos = editorView.posAtCoords({ line: cursor.line, ch: cursor.ch });\n                if (pos !== null && pos !== undefined) {\n                    const coords = editorView.coordsAtPos(pos);\n                    if (coords) {\n                        x = coords.left || 0;\n                        y = (coords.top || 0) + 25;\n                    }\n                }\n            }\n        } catch { }\n\n        if (x === 0 && y === 0) {\n            const activeEl = activeDocument.activeElement;\n            if (activeEl) {\n                const rect = activeEl.getBoundingClientRect();\n                x = rect.left + 20;\n                y = rect.top + 40;\n            }\n        }\n        if (x === 0 && y === 0) {\n            x = window.innerWidth / 2 - 150;\n            y = window.innerHeight / 2 - 100;\n        }\n        this.relatedPopout?.showWithEntries(startBcv, formatted, matchingEntries, x, y);\n    }\n\n    // ============================================================\n    // EXPORT\n    // ============================================================\n\n    async exportConcordance(): Promise<void> {\n        if (!this.indexer) {\n            new Notice('Indexer not initialized');\n            return;\n        }\n        const data = this.indexer.getData();\n        if (!data || Object.keys(data.references).length === 0) {\n            new Notice('No references to export');\n            return;\n        }\n        try {\n            const content = this.generateConcordanceContent(data);\n            const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, '');\n            const fileName = `Concordance-${timestamp}.md`;\n            const filePath = `/${fileName}`;\n            const file = await this.app.vault.create(filePath, content);\n            await this.app.workspace.openLinkText(file.path, '');\n            new Notice(`Concordance exported: ${fileName}`);\n        } catch {\n            new Notice('Export failed. See console for details.');\n        }\n    }\n\n    private generateConcordanceContent(data: any): string {\n        const lines: string[] = [];\n        const vaultName = this.app.vault.getName();\n        lines.push(`# ${vaultName} — Scripture Concordance`);\n        lines.push('');\n        lines.push(`Generated: ${new Date().toLocaleString()}`);\n        lines.push(`Unique references: ${Object.keys(data.references).length}`);\n        lines.push(`Files indexed: ${Object.keys(data.fileCache).length}`);\n        lines.push('');\n        lines.push('---');\n\n        const grouped = this.indexer!.getGroupedReferences();\n        for (const [bookId, chapterMap] of grouped) {\n            const bookName = getBookName(\n                bookId,\n                this.settings.outputLanguage,\n                'full'\n            );\n            lines.push(`## ${bookName || `Book ${bookId}`}`);\n            lines.push('');\n            const allRefs: Array<[string, ReferenceIndexEntry, string | null]> = [];\n            for (const [, refs] of chapterMap) {\n                for (const ref of refs) {\n                    allRefs.push(ref);\n                }\n            }\n            allRefs.sort((a, b) => {\n                const aStart = a[0].split('-')[0];\n                const bStart = b[0].split('-')[0];\n                const aCh = parseInt(aStart.substring(2, 5));\n                const bCh = parseInt(bStart.substring(2, 5));\n                if (aCh !== bCh) return aCh - bCh;\n                return parseInt(aStart.substring(5, 8)) - parseInt(bStart.substring(5, 8));\n            });\n\n            for (const [key, entry, formatted] of allRefs) {\n                let formattedRef: string;\n                if (formatted) {\n                    formattedRef = formatted;\n                } else {\n                    const ranges: Array<[string, string]> = [[\n                        `${String(entry.bcv.bookId).padStart(2, '0')}${String(entry.bcv.chapter).padStart(3, '0')}${String(entry.bcv.startVerse).padStart(3, '0')}`,\n                        `${String(entry.bcv.bookId).padStart(2, '0')}${String(entry.bcv.endChapter !== undefined && entry.bcv.endChapter !== entry.bcv.chapter ? entry.bcv.endChapter : entry.bcv.chapter).padStart(3, '0')}${String(entry.bcv.endVerse).padStart(3, '0')}`\n                    ]];\n                    const decoded = decodeScriptures(\n                        ranges,\n                        this.settings.outputLanguage,\n                        this.settings.nameFormat\n                    );\n                    formattedRef = decoded && decoded.length > 0 ? decoded[0] : `${entry.startBcv}-${entry.endBcv}`;\n                }\n\n                const filesWithCounts = this.db?.getFilesWithCounts(key) || [];\n                const sortedFiles = filesWithCounts\n                    .map(f => ({ path: f.path, occurrences: f.occurrences }))\n                    .sort((a, b) => a.path.localeCompare(b.path));\n                const fileEntries: string[] = [];\n                for (const file of sortedFiles) {\n                    const fileName = file.path.replace(/\\.md$/, '');\n                    fileEntries.push(`[[${fileName}]]\\u2009(${file.occurrences})`);\n                }\n                lines.push(`**${formattedRef}** — ${fileEntries.join('; ')}`);\n            }\n            lines.push('');\n            lines.push('---');\n        }\n        lines.push('---');\n        lines.push('');\n        lines.push(`*Generated by \\`con[VER]sum v${this.manifest.version}\\`*`);\n        return lines.join('\\n');\n    }\n}\n
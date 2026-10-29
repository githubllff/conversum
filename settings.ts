// settings.ts

import { PluginSettingTab, Setting, Notice } from 'obsidian';
import { getAvailableLanguages, getEngineVersion } from './engine-wrapper';
import type ConversumPlugin from './main';

export class ConversumSettingTab extends PluginSettingTab {
    plugin: ConversumPlugin;

    constructor(app: any, plugin: ConversumPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        const headerEl = containerEl.createDiv({ cls: 'conversum-settings-header' });
        headerEl.createSpan({ text: 'con[VER]sum', cls: 'conversum-settings-title' });
        const engineVersion = getEngineVersion();
        headerEl.createSpan({ 
            text: `v${this.plugin.manifest.version} – ${engineVersion}`,
            cls: 'conversum-version-info'
        });

        this.renderSettings(containerEl);

        const statusEl = containerEl.createDiv({ cls: 'conversum-status' });
        const data = this.plugin.indexer?.getData();
        const lastUpdated = data?.lastUpdated;
        const refCount = data ? Object.keys(data.references).length : 0;
        if (lastUpdated && lastUpdated > 0) {
            const date = new Date(lastUpdated);
            statusEl.createEl('p', {
                text: `Index updated: ${date.toLocaleString()}`,
                cls: 'conversum-status-item'
            });
        } else {
            statusEl.createEl('p', {
                text: 'Index not built',
                cls: 'conversum-status-item'
            });
        }
        statusEl.createEl('p', {
            text: `Unique references: ${refCount}`,
            cls: 'conversum-status-item'
        });
        const isIndexing = this.plugin.indexer?.isIndexingBusy() || false;
        const isFormatting = this.plugin.isFormattingBusy();
        const unformatted = this.plugin.getUnformattedCount();
        if (isIndexing) {
            statusEl.createEl('p', {
                text: 'Indexing in progress...',
                cls: 'conversum-status-item conversum-status-formatting'
            });
        }
        if (isFormatting) {
            statusEl.createEl('p', {
                text: `Formatting in progress... (${unformatted} remaining)`,
                cls: 'conversum-status-item conversum-status-formatting'
            });
        } else if (unformatted > 0) {
            statusEl.createEl('p', {
                text: `${unformatted} references need formatting`,
                cls: 'conversum-status-item conversum-status-warning'
            });
        } else if (refCount > 0) {
            statusEl.createEl('p', {
                text: 'All references formatted',
                cls: 'conversum-status-item conversum-status-ok'
            });
        }

        const footerEl = containerEl.createDiv({ cls: 'conversum-settings-footer' });
        const footerText = footerEl.createSpan();
        footerText.appendChild(document.createTextNode('My other Obsidian plugin: '));
        footerText.createEl('strong', { text: 'tra.VER:ture' });
        footerText.appendChild(document.createTextNode(': '));
        const githubLink = footerText.createEl('a', {
            text: 'GitHub repo',
            href: 'https://github.com/erykjj/traverture'
        });
        githubLink.setAttribute('target', '_blank');
        githubLink.setAttribute('rel', 'noopener noreferrer');
        footerText.appendChild(document.createTextNode(', '));
        const obsidianLink = footerText.createEl('a', {
            text: 'Obsidian Community',
            href: 'https://community.obsidian.md/plugins/traverture'
        });
        obsidianLink.setAttribute('target', '_blank');
        obsidianLink.setAttribute('rel', 'noopener noreferrer');
    }

    private renderSettings(containerEl: HTMLElement): void {
        const languages = getAvailableLanguages();
        const nonAslLanguages = languages.filter((l: any) => l.code !== 'ase');
        const langOptions = nonAslLanguages.map((l: any) => ({
            value: l.code,
            display: `${l.vernacularName} (${l.code})`
        }));

        new Setting(containerEl).setName('Language').setHeading();

        new Setting(containerEl)
            .setName('Source language')
            .setDesc('Language of the scripture references in your notes. Changing this will force a full reindex.')
            .addDropdown((dropdown) => {
                for (const opt of langOptions) {
                    dropdown.addOption(opt.value, opt.display);
                }
                dropdown.setValue(this.plugin.settings.sourceLanguage);
                dropdown.onChange(async (value) => {
                    this.plugin.settings.sourceLanguage = value;
                    await this.plugin.saveSettings();
                    this.plugin.updateIndexerSettings();
                    await this.plugin.rebuildIndex();
                    this.display();
                    new Notice(`Source language updated to ${value}. Reindexing complete.`);
                });
            });

        new Setting(containerEl)
            .setName('Output language')
            .setDesc('Language for displaying book names and references')
            .addDropdown((dropdown) => {
                for (const opt of langOptions) {
                    dropdown.addOption(opt.value, opt.display);
                }
                dropdown.setValue(this.plugin.settings.outputLanguage);
                dropdown.onChange(async (value) => {
                    this.plugin.settings.outputLanguage = value;
                    await this.plugin.saveSettings();
                    this.plugin.updateIndexerSettings();
                    await this.plugin.reformatAllReferences();
                    this.display();
                    new Notice(`Output language updated to ${value}`);
                });
            });

        new Setting(containerEl)
            .setName('Reference format')
            .setDesc('How scripture references are displayed')
            .addDropdown((dropdown) => {
                dropdown.addOption('full', 'Full (1 Corinthians)');
                dropdown.addOption('standard', 'Standard (1 Cor.)');
                dropdown.addOption('official', 'Official (1Co)');
                dropdown.setValue(this.plugin.settings.nameFormat);
                dropdown.onChange(async (value: string) => {
                    this.plugin.settings.nameFormat = value as 'full' | 'standard' | 'official';
                    await this.plugin.saveSettings();
                    this.plugin.updateIndexerSettings();
                    await this.plugin.reformatAllReferences();
                    this.display();
                });
            });

        new Setting(containerEl).setName('Index').setHeading();

        new Setting(containerEl)
            .setName('Auto-index')
            .setDesc('Automatically update the index when files change')
            .addToggle((toggle) => {
                toggle.setValue(this.plugin.settings.autoIndex);
                toggle.onChange(async (value) => {
                    this.plugin.settings.autoIndex = value;
                    await this.plugin.saveSettings();
                    if (value) {
                        this.plugin.startFileWatcher();
                        const data = this.plugin.indexer?.getData();
                        if (!data || Object.keys(data.references).length === 0) {
                            await this.plugin.rebuildIndex();
                        }
                    } else {
                        this.plugin.stopFileWatcher();
                    }
                    this.display();
                });
            });

        const configDir = this.plugin.app.vault.configDir;
        new Setting(containerEl)
            .setName('Excluded folders')
            .setDesc(`Additional folders to exclude from indexing (comma-separated). _templates, _attachments, and ${configDir} are always excluded.`)
            .addText((text) => {
                text.setPlaceholder('my_notes, drafts, archive');
                text.setValue(this.plugin.settings.excludedFolders.join(', '));
                text.onChange(async (value) => {
                    const folders = value.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
                    this.plugin.settings.excludedFolders = folders;
                    await this.plugin.saveSettings();
                    this.plugin.updateIndexerSettings();
                    if (this.plugin.settings.autoIndex) {
                        await this.plugin.rebuildIndex();
                    }
                    this.display();
                });
            });

        new Setting(containerEl)
            .setName('Rebuild index')
            .setDesc('Force a full rebuild of the concordance index')
            .addButton((button) => {
                button.setButtonText('Rebuild');
                button.setCta();
                button.onClick(async () => {
                    if (this.plugin.indexer?.isBusy()) {
                        new Notice('Indexing already in progress');
                        return;
                    }
                    await this.plugin.rebuildIndex();
                    this.display();
                });
            });

        new Setting(containerEl)
            .setName('Auto-backup index')
            .setDesc('Keep a rolling backup copy of the index (.bak) so it can be restored if the app crashes or the index becomes corrupt.')
            .addToggle((toggle) => {
                toggle.setValue(this.plugin.settings.autoBackup);
                toggle.onChange(async (value) => {
                    this.plugin.settings.autoBackup = value;
                    await this.plugin.saveSettings();
                    this.display();
                });
            });

        new Setting(containerEl)
            .setName('Reformat all references')
            .setDesc('Regenerate the human-readable formatted names for all indexed references (useful after changing the output language or format).')
            .addButton((button) => {
                button.setButtonText('Reformat');
                button.onClick(async () => {
                    if (this.plugin.indexer?.isBusy()) {
                        new Notice('Indexing or formatting is in progress. Wait for it to finish, then try again.');
                        return;
                    }
                    await this.plugin.reformatAllReferences();
                    this.display();
                    new Notice('Reformatting started in the background.');
                });
            });

        new Setting(containerEl)
            .setName('Stop indexing')
            .setDesc('Abort an in-progress index rebuild.')
            .addButton((button) => {
                button.setButtonText('Stop');
                button.setWarning();
                button.onClick(async () => {
                    const indexer = this.plugin.indexer;
                    if (indexer?.isIndexingBusy() || indexer?.isFormattingBusy()) {
                        indexer.abort();
                        const start = Date.now();
                        while (indexer.isBusy() && Date.now() - start < 5000) {
                            await new Promise((resolve) => window.setTimeout(resolve, 100));
                        }
                        if (indexer.isBusy()) {
                            this.plugin.forceResetBusyState();
                        }
                        new Notice('Stopped.');
                    } else {
                        new Notice('No indexing or formatting in progress.');
                    }
                    this.display();
                });
            });

        new Setting(containerEl)
            .setName('Stop formatting')
            .setDesc('Abort background formatting of reference names.')
            .addButton((button) => {
                button.setButtonText('Stop');
                button.setWarning();
                button.onClick(() => {
                    if (this.plugin.indexer?.isFormattingBusy()) {
                        this.plugin.indexer.abortFormatting();
                        new Notice('Stopping formatting...');
                    } else {
                        new Notice('No formatting in progress.');
                    }
                    this.display();
                });
            });

        new Setting(containerEl)
            .setName('Reset busy state')
            .setDesc('Force-clear a stuck indexing/formatting state if Stop does not work. Use only if an operation appears hung.')
            .addButton((button) => {
                button.setButtonText('Reset');
                button.setWarning();
                button.onClick(() => {
                    this.plugin.forceResetBusyState();
                    this.display();
                });
            });

        new Setting(containerEl).setName('Database').setHeading();

        new Setting(containerEl)
            .setName('Import compiled database')
            .setDesc(
                'Replace the current index with a database compiled on another device, such as a desktop. ' +
                'Choose a .db file, or place it at the vault root as conversum-index.db and use "From vault". ' +
                'Files that match the imported index are marked as up to date so they are not reindexed.'
            )
            .addButton((button) => {
                button.setButtonText('Choose file');
                button.setWarning();
                button.onClick(() => this.openDatabaseFilePicker());
            })
            .addButton((button) => {
                button.setButtonText('From vault');
                button.onClick(() => {
                    void this.importDatabaseFromVault();
                });
            });

        new Setting(containerEl)
            .setName('Export compiled database')
            .setDesc(
                'Save a copy of the current index as conversum-index.db at the vault root. ' +
                'Sync this file to another device, then use "From vault" there to import it.'
            )
            .addButton((button) => {
                button.setButtonText('Export');
                button.onClick(() => {
                    void this.exportDatabaseToVault();
                });
            });

        new Setting(containerEl)
            .setName('Restore from backup')
            .setDesc(
                'Restore the index from the automatic backup copy (.bak) if the current index is corrupt or missing. ' +
                'The current index is kept as a .corrupt file.'
            )
            .addButton((button) => {
                button.setButtonText('Restore');
                button.setWarning();
                button.onClick(() => {
                    void this.restoreFromBackup();
                });
            });
    }

    private openDatabaseFilePicker(): void {
        if (this.plugin.indexer?.isBusy()) {
            new Notice('Indexing or formatting is in progress. Wait for it to finish, then try again.');
            return;
        }

        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.db,.sqlite,.sqlite3,application/octet-stream,application/x-sqlite3';
        input.style.display = 'none';

        const cleanup = (): void => {
            if (input.parentNode) {
                input.parentNode.removeChild(input);
            }
        };

        input.addEventListener('change', () => {
            const file = input.files && input.files[0];
            if (!file) {
                cleanup();
                return;
            }
            void this.runDatabaseImport(() => this.readFileAsArrayBuffer(file)).finally(cleanup);
        }, { once: true });

        document.body.appendChild(input);
        input.click();
        window.setTimeout(cleanup, 120000);
    }

    private async importDatabaseFromVault(): Promise<void> {
        const path = 'conversum-index.db';
        await this.runDatabaseImport(async () => {
            const adapter = this.plugin.app.vault.adapter;
            if (!(await adapter.exists(path))) {
                throw new Error(`No ${path} found at the vault root.`);
            }
            return await adapter.readBinary(path);
        });
    }

    private async runDatabaseImport(load: () => Promise<ArrayBuffer>): Promise<void> {
        const indexer = this.plugin.indexer;
        if (indexer?.isBusy()) {
            indexer.abort();
            const start = Date.now();
            while (indexer.isBusy() && Date.now() - start < 5000) {
                await new Promise((resolve) => window.setTimeout(resolve, 100));
            }
            if (indexer.isBusy()) {
                this.plugin.forceResetBusyState();
            }
        }

        const notice = new Notice('Importing database...', 0);
        try {
            const bytes = await load();
            if (bytes.byteLength === 0) {
                throw new Error('The selected file is empty.');
            }
            await this.plugin.importDatabase(bytes);
        } catch (e) {
            await this.plugin.getLogger()?.error('Database import failed', e);
            const message = e instanceof Error ? e.message : String(e);
            new Notice(`Database import failed: ${message}`, 10000);
        } finally {
            notice.hide();
        }
    }

    private async restoreFromBackup(): Promise<void> {
        if (this.plugin.indexer?.isBusy()) {
            new Notice('Indexing or formatting is in progress. Wait for it to finish, then try again.');
            return;
        }
        if (!(await this.plugin.getDatabase()?.hasBackup())) {
            new Notice('No backup database found.');
            return;
        }
        const notice = new Notice('Restoring from backup...', 0);
        try {
            const counts = await this.plugin.getDatabase()!.restoreFromBackup();
            this.plugin.indexer?.setData(this.plugin.getDatabase()!.getData());
            this.plugin.refreshConcordanceView();
            this.plugin.refreshSettings();
            new Notice(`Restored from backup: ${counts.refs} references, ${counts.occurrences} occurrences, ${counts.files} files.`);
        } catch (e) {
            await this.plugin.getLogger()?.error('Restore from backup failed', e);
            const message = e instanceof Error ? e.message : String(e);
            new Notice(`Restore from backup failed: ${message}`, 10000);
        } finally {
            notice.hide();
        }
    }

    private async exportDatabaseToVault(): Promise<void> {
        try {
            const path = await this.plugin.exportDatabaseToVault();
            new Notice(`Database exported to vault root: ${path}`);
        } catch (e) {
            await this.plugin.getLogger()?.error('Database export failed', e);
            const message = e instanceof Error ? e.message : String(e);
            new Notice(`Database export failed: ${message}`, 10000);
        }
    }

    private readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as ArrayBuffer);
            reader.onerror = () => reject(reader.error || new Error('Could not read the selected file.'));
            reader.readAsArrayBuffer(file);
        });
    }
}
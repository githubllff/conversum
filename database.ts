// database.ts

// @ts-ignore
import { SQL_WASM_BASE64 } from './wasm-base64';
import initSqlJs, { Database as SqlDatabase } from 'sql.js';
import { isWholeBookReference } from './engine-wrapper';
import type ConversumPlugin from './main';
import { ConversumData, ReferenceIndexEntry, FileCacheEntry } from './types';

const DB_NAME = 'conversum-index.db';

export class IndexDatabase {
    private plugin: ConversumPlugin;
    private db: SqlDatabase | null = null;
    private SQL: any = null;
    private initialized = false;
    private data: ConversumData = {
        version: '',
        lastUpdated: 0,
        references: {},
        fileCache: {}
    };
    private inTransaction = false;
    private saveInProgress: Promise<void> = Promise.resolve();

    constructor(plugin: ConversumPlugin) {
        this.plugin = plugin;
    }

    // ============================================================
    // INITIALIZATION
    // ============================================================

    async init(): Promise<void> {
        if (this.initialized) return;
        const adapter = this.plugin.app.vault.adapter;
        const dir = '.obsidian/plugins/conversum';
        const dbPath = `${dir}/${DB_NAME}`;
        const backupPath = `${dir}/${DB_NAME}.bak`;

        const ensureSql = async (): Promise<void> => {
            if (!this.SQL) {
                this.SQL = await initSqlJs({
                    locateFile: () => {
                        return `data:application/wasm;base64,${SQL_WASM_BASE64}`;
                    }
                });
            }
        };

        try {
            await ensureSql();

            let dbData: Uint8Array | null = null;
            let loadedFromBackup = false;

            try {
                const fileExists = await adapter.exists(dbPath);
                if (fileExists) {
                    const fileContent = await adapter.readBinary(dbPath);
                    const candidate = new Uint8Array(fileContent);
                    try {
                        const testDb = new this.SQL.Database(candidate);
                        testDb.close();
                        dbData = candidate;
                    } catch (corruptErr) {
                        console.warn('con[VER]sum: Primary database appears corrupt, attempting recovery', corruptErr);
                        try {
                            await adapter.rename(dbPath, `${dbPath}.corrupt.${Date.now()}`);
                        } catch {
                        }
                        dbData = null;
                    }
                }
            } catch {
            }

            if (!dbData) {
                try {
                    const backupExists = await adapter.exists(backupPath);
                    if (backupExists) {
                        const fileContent = await adapter.readBinary(backupPath);
                        const candidate = new Uint8Array(fileContent);
                        const testDb = new this.SQL.Database(candidate);
                        testDb.close();
                        dbData = candidate;
                        loadedFromBackup = true;
                    }
                } catch {
                    dbData = null;
                }
            }

            this.db = dbData ? new this.SQL.Database(dbData) : new this.SQL.Database();
            this.db!.run('PRAGMA foreign_keys = ON;');
            this.createTables();
            try {
                this.cleanupOrphans();
            } catch {
            }
            try {
                await this.loadDataFromDB();
            } catch (loadErr) {
                console.error('con[VER]sum: Failed to load data from database, resetting tables', loadErr);
                try {
                    this.db!.run('DELETE FROM ref_occurrences');
                    this.db!.run('DELETE FROM ref_detail');
                    this.db!.run('DELETE FROM file_index');
                    this.db!.run('DELETE FROM metadata');
                } catch {
                }
                this.data = {
                    version: this.plugin.manifest.version,
                    lastUpdated: 0,
                    references: {},
                    fileCache: {}
                };
            }
            this.initialized = true;
            await this.saveToDisk();
            if (loadedFromBackup) {
                console.log('con[VER]sum: Recovered database from backup copy');
            }
        } catch (e) {
            console.error('con[VER]sum: Failed to initialize SQLite, creating fresh database:', e);
            try {
                await ensureSql();
                if (this.db) {
                    try { this.db.close(); } catch { }
                }
                this.db = new this.SQL.Database();
                this.db!.run('PRAGMA foreign_keys = ON;');
                this.createTables();
                this.data = {
                    version: this.plugin.manifest.version,
                    lastUpdated: 0,
                    references: {},
                    fileCache: {}
                };
                this.initialized = true;
                await this.saveToDisk();
            } catch (e2) {
                console.error('con[VER]sum: Critical failure initializing SQLite:', e2);
                throw e2;
            }
        }
    }

    async resetDatabase(): Promise<void> {
        try {
            if (this.inTransaction && this.db) {
                this.rollbackTransaction();
            }
            if (this.db) {
                try {
                    this.db.close();
                } catch {
                }
            }
            if (!this.SQL) {
                this.SQL = await initSqlJs({
                    locateFile: () => `data:application/wasm;base64,${SQL_WASM_BASE64}`
                });
            }
            this.db = new this.SQL.Database();
            this.db!.run('PRAGMA foreign_keys = ON;');
            this.createTables();
            this.data = {
                version: this.plugin.manifest.version,
                lastUpdated: 0,
                references: {},
                fileCache: {}
            };
            this.inTransaction = false;
        } catch (e) {
            console.error('con[VER]sum: Failed to reset database:', e);
            throw e;
        }
    }

    private createTables(): void {
        if (!this.db) return;
        this.db.run(`
            CREATE TABLE IF NOT EXISTS file_index (
                file_path TEXT PRIMARY KEY,
                last_modified INTEGER NOT NULL,
                language TEXT
            )
        `);
        this.db.run(`
            CREATE TABLE IF NOT EXISTS ref_detail (
                range_key TEXT PRIMARY KEY,
                start_bcv TEXT NOT NULL,
                end_bcv TEXT NOT NULL,
                book_id INTEGER NOT NULL,
                chapter INTEGER NOT NULL,
                start_verse INTEGER NOT NULL,
                end_verse INTEGER NOT NULL,
                end_chapter INTEGER,
                formatted TEXT
            )
        `);
        this.db.run(`
            CREATE TABLE IF NOT EXISTS ref_occurrences (
                range_key TEXT NOT NULL,
                file_path TEXT NOT NULL,
                FOREIGN KEY (range_key) REFERENCES ref_detail(range_key) ON DELETE CASCADE,
                FOREIGN KEY (file_path) REFERENCES file_index(file_path) ON DELETE CASCADE
            )
        `);
        this.db.run(`
            CREATE TABLE IF NOT EXISTS metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
        `);

        this.db.run(`
            CREATE INDEX IF NOT EXISTS idx_ref_detail_book_chapter 
            ON ref_detail (book_id, chapter)
        `);
        this.db.run(`
            CREATE INDEX IF NOT EXISTS idx_ref_detail_start_verse 
            ON ref_detail (start_verse)
        `);
        this.db.run(`
            CREATE INDEX IF NOT EXISTS idx_ref_occ_range_key 
            ON ref_occurrences (range_key)
        `);
        this.db.run(`
            CREATE INDEX IF NOT EXISTS idx_ref_occ_file_path 
            ON ref_occurrences (file_path)
        `);
    }

    private async loadDataFromDB(): Promise<void> {
        if (!this.db) return;
        try {
            const metaResult = this.db.exec('SELECT key, value FROM metadata');
            if (metaResult.length > 0) {
                const rows = metaResult[0].values;
                for (const row of rows) {
                    const key = row[0] as string;
                    const value = row[1] as string;
                    if (key === 'version') {
                        this.data.version = value;
                    } else if (key === 'lastUpdated') {
                        this.data.lastUpdated = parseInt(value, 10);
                    }
                }
            }

            const fileResult = this.db.exec('SELECT * FROM file_index');
            if (fileResult.length > 0) {
                const columns = fileResult[0].columns;
                const rows = fileResult[0].values;
                for (const row of rows) {
                    const filePath = row[columns.indexOf('file_path')] as string;
                    const lastModified = row[columns.indexOf('last_modified')] as number;
                    this.data.fileCache[filePath] = { 
                        hash: '',
                        references: [],
                        lastModified 
                    };
                }
            }

            const refResult = this.db.exec(`
                SELECT 
                    d.range_key,
                    d.start_bcv,
                    d.end_bcv,
                    d.book_id,
                    d.chapter,
                    d.start_verse,
                    d.end_verse,
                    d.end_chapter,
                    d.formatted,
                    o.file_path
                FROM ref_detail d
                JOIN ref_occurrences o ON d.range_key = o.range_key
                ORDER BY d.book_id, d.chapter, d.start_verse
            `);
            if (refResult.length > 0) {
                const columns = refResult[0].columns;
                const rows = refResult[0].values;
                const refMap = new Map<string, { 
                    entry: ReferenceIndexEntry; 
                    filePaths: Set<string>; 
                    occurrenceCounts: Map<string, number> 
                }>();
                for (const row of rows) {
                    const rangeKey = row[columns.indexOf('range_key')] as string;
                    const startBcv = row[columns.indexOf('start_bcv')] as string;
                    const endBcv = row[columns.indexOf('end_bcv')] as string;
                    const bookId = row[columns.indexOf('book_id')] as number;
                    const chapter = row[columns.indexOf('chapter')] as number;
                    const startVerse = row[columns.indexOf('start_verse')] as number;
                    const endVerse = row[columns.indexOf('end_verse')] as number;
                    const endChapter = row[columns.indexOf('end_chapter')] as number;
                    const filePath = row[columns.indexOf('file_path')] as string;
                    if (!refMap.has(rangeKey)) {
                        refMap.set(rangeKey, {
                            entry: {
                                startBcv,
                                endBcv,
                                bcv: { bookId, chapter, startVerse, endVerse, endChapter },
                                files: [],
                                totalOccurrences: 0
                            },
                            filePaths: new Set(),
                            occurrenceCounts: new Map()
                        });
                    }
                    const data = refMap.get(rangeKey)!;
                    data.filePaths.add(filePath);
                    const currentCount = data.occurrenceCounts.get(filePath) || 0;
                    data.occurrenceCounts.set(filePath, currentCount + 1);
                }

                for (const [rangeKey, data] of refMap) {
                    const files: {path: string, occurrences: number}[] = [];
                    let totalOccurrences = 0;
                    for (const [filePath, count] of data.occurrenceCounts) {
                        files.push({ path: filePath, occurrences: count });
                        totalOccurrences += count;
                    }
                    files.sort((a, b) => a.path.localeCompare(b.path));
                    data.entry.files = files;
                    data.entry.totalOccurrences = totalOccurrences;
                    this.data.references[rangeKey] = data.entry;
                    for (const filePath of data.filePaths) {
                        if (this.data.fileCache[filePath]) {
                            if (!this.data.fileCache[filePath].references.includes(rangeKey)) {
                                this.data.fileCache[filePath].references.push(rangeKey);
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.error('con[VER]sum: Failed to load data from SQLite:', e);
            throw e;
        }
    }

    async vacuum(): Promise<void> {
        if (!this.db || this.inTransaction) return;
        try {
            this.db.run('VACUUM');
        } catch {
        }
    }

    private ensureForeignKeys(): void {
        if (!this.db) return;
        try {
            // sql.js resets PRAGMA foreign_keys to OFF after db.export(),
            // so it must be re-enabled after every export.
            this.db.run('PRAGMA foreign_keys = ON;');
        } catch {
        }
    }

    private async doSaveToDisk(): Promise<void> {
        if (!this.db) return;
        const adapter = this.plugin.app.vault.adapter;
        const dir = '.obsidian/plugins/conversum';
        const dbPath = `${dir}/${DB_NAME}`;
        const tmpPath = `${dir}/${DB_NAME}.tmp`;
        const backupPath = `${dir}/${DB_NAME}.bak`;

        const writeMetadata = (): void => {
            this.db!.run(
                'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)',
                ['version', this.data.version]
            );
            this.db!.run(
                'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)',
                ['lastUpdated', String(this.data.lastUpdated)]
            );
        };

        try {
            writeMetadata();
            const dbData = this.db.export();
            this.ensureForeignKeys();

            await adapter.writeBinary(tmpPath, dbData as any);

            const mainExists = await adapter.exists(dbPath);
            if (mainExists) {
                if (await adapter.exists(backupPath)) {
                    await adapter.remove(backupPath);
                }
                await adapter.rename(dbPath, backupPath);
            }
            await adapter.rename(tmpPath, dbPath);

            if (await adapter.exists(backupPath)) {
                await adapter.remove(backupPath);
            }
        } catch (e) {
            console.error('con[VER]sum: Atomic save failed, attempting direct write:', e);
            try {
                if (!(await adapter.exists(dbPath)) && (await adapter.exists(backupPath))) {
                    await adapter.rename(backupPath, dbPath);
                }
            } catch {
            }
            try {
                writeMetadata();
                const dbData = this.db.export();
                this.ensureForeignKeys();
                await adapter.writeBinary(dbPath, dbData as any);
            } catch (e2) {
                console.error('con[VER]sum: Failed to save database to disk:', e2);
            }
        }
    }

    async saveToDisk(): Promise<void> {
        if (!this.db) return;
        this.saveInProgress = this.saveInProgress
            .catch(() => {})
            .then(() => this.doSaveToDisk());
        return this.saveInProgress;
    }

    // ============================================================
    // TRANSACTION MANAGEMENT
    // ============================================================

    beginTransaction(): void {
        if (!this.db) return;
        if (this.inTransaction) {
            return;
        }
        this.db.run('BEGIN TRANSACTION');
        this.inTransaction = true;
    }

    async commitTransaction(save: boolean = false): Promise<void> {
        if (!this.db) {
            this.inTransaction = false;
            return;
        }
        if (!this.inTransaction) {
            return;
        }
        try {
            this.db.run('COMMIT');
            this.inTransaction = false;
            if (save) {
                await this.saveToDisk();
            }
        } catch (e) {
            this.inTransaction = false;
            console.error('con[VER]sum: Failed to commit transaction:', e);
            throw e;
        }
    }

    rollbackTransaction(): void {
        if (!this.db) {
            this.inTransaction = false;
            return;
        }
        if (!this.inTransaction) {
            return;
        }
        try {
            this.db.run('ROLLBACK');
            this.inTransaction = false;
        } catch (e) {
            console.warn('con[VER]sum: Rollback failed:', e);
            this.inTransaction = false;
        }
    }

    isInTransaction(): boolean {
        return this.inTransaction;
    }

    // ============================================================
    // READ OPERATIONS
    // ============================================================

    getData(): ConversumData {
        return this.data;
    }

    setData(data: ConversumData): void {
        this.data = data;
    }

    isInitialized(): boolean {
        return this.initialized;
    }

    getReference(rangeKey: string): ReferenceIndexEntry | null {
        return this.data.references[rangeKey] || null;
    }

    getAllReferences(): { [rangeKey: string]: ReferenceIndexEntry } {
        return this.data.references;
    }

    getFileCache(filePath: string): FileCacheEntry | null {
        return this.data.fileCache[filePath] || null;
    }

    getAllFileCache(): { [filePath: string]: FileCacheEntry } {
        return this.data.fileCache;
    }

    getFileLanguage(filePath: string): string | null {
        if (!this.db) return null;
        const result = this.db.exec(`
            SELECT language FROM file_index WHERE file_path = ?
        `, [filePath]);
        if (result.length === 0 || result[0].values.length === 0) return null;
        return result[0].values[0][0] as string || null;
    }

    getFileIndex(filePath: string): { lastModified: number; language: string | null } | null {
        if (!this.db) return null;
        const result = this.db.exec(`
            SELECT last_modified, language
            FROM file_index
            WHERE file_path = ?
        `, [filePath]);
        if (result.length === 0 || result[0].values.length === 0) return null;
        const row = result[0].values[0];
        return {
            lastModified: row[0] as number,
            language: row[1] as string || null
        };
    }

    getUnformattedCount(): number {
        if (!this.db) return 0;
        const result = this.db.exec(`
            SELECT COUNT(DISTINCT range_key) 
            FROM ref_detail 
            WHERE formatted IS NULL
        `);
        if (result.length === 0) return 0;
        return result[0].values[0][0] as number;
    }

    getAllRangeKeys(): string[] {
        if (!this.db) return [];
        const result = this.db.exec(`
            SELECT DISTINCT range_key FROM ref_detail
        `);
        if (result.length === 0) return [];
        return result[0].values.map(row => row[0] as string);
    }

    getUnformattedRangeKeys(limit: number): string[] {
        if (!this.db) return [];
        const result = this.db.exec(`
            SELECT range_key 
            FROM ref_detail 
            WHERE formatted IS NULL
            LIMIT ?
        `, [limit]);
        if (result.length === 0) return [];
        return result[0].values.map(row => row[0] as string);
    }

    isFullyFormatted(): boolean {
        return this.getUnformattedCount() === 0;
    }

    getReferenceCount(): number {
        if (!this.db) return 0;
        const result = this.db.exec(`
            SELECT COUNT(DISTINCT range_key) FROM ref_detail
        `);
        if (result.length === 0) return 0;
        return result[0].values[0][0] as number;
    }

    getOccurrenceCount(): number {
        if (!this.db) return 0;
        const result = this.db.exec(`
            SELECT COUNT(*) FROM ref_occurrences
        `);
        if (result.length === 0) return 0;
        return result[0].values[0][0] as number;
    }

    getFileCount(): number {
        if (!this.db) return 0;
        const result = this.db.exec(`
            SELECT COUNT(*) FROM file_index
        `);
        if (result.length === 0) return 0;
        return result[0].values[0][0] as number;
    }

    getOccurrenceData(rangeKey: string): {
        startBcv: string;
        endBcv: string;
        bookId: number;
        chapter: number;
        startVerse: number;
        endVerse: number;
        endChapter: number | null;
    } | null {
        if (!this.db) return null;
        const result = this.db.exec(`
            SELECT start_bcv, end_bcv, book_id, chapter, 
                   start_verse, end_verse, end_chapter
            FROM ref_detail 
            WHERE range_key = ?
        `, [rangeKey]);
        if (result.length === 0 || result[0].values.length === 0) return null;
        const row = result[0].values[0];
        return {
            startBcv: row[0] as string,
            endBcv: row[1] as string,
            bookId: row[2] as number,
            chapter: row[3] as number,
            startVerse: row[4] as number,
            endVerse: row[5] as number,
            endChapter: row[6] as number | null
        };
    }

    getFilesWithCounts(rangeKey: string): Array<{path: string, occurrences: number}> {
        if (!this.db) return [];
        const result = this.db.exec(`
            SELECT file_path, COUNT(*) as count
            FROM ref_occurrences
            WHERE range_key = ?
            GROUP BY file_path
            ORDER BY file_path
        `, [rangeKey]);
        if (result.length === 0) return [];
        const files: Array<{path: string, occurrences: number}> = [];
        const columns = result[0].columns;
        for (const row of result[0].values) {
            files.push({
                path: row[columns.indexOf('file_path')] as string,
                occurrences: row[columns.indexOf('count')] as number
            });
        }
        return files;
    }

    getTotalOccurrences(rangeKey: string): number {
        if (!this.db) return 0;
        const result = this.db.exec(`
            SELECT COUNT(*) FROM ref_occurrences WHERE range_key = ?
        `, [rangeKey]);
        if (result.length === 0 || result[0].values.length === 0) return 0;
        return result[0].values[0][0] as number;
    }

    getFormatted(rangeKey: string): string | null {
        if (!this.db) return null;
        const result = this.db.exec(`
            SELECT formatted FROM ref_detail WHERE range_key = ?
        `, [rangeKey]);
        if (result.length === 0 || result[0].values.length === 0) return null;
        return result[0].values[0][0] as string || null;
    }

    // ============================================================
    // WRITE OPERATIONS
    // ============================================================

    insertOccurrence(
        rangeKey: string,
        filePath: string,
        startBcv: string,
        endBcv: string,
        bookId: number,
        chapter: number,
        startVerse: number,
        endVerse: number,
        endChapter?: number
    ): void {
        if (!this.db) return;
        try {
            this.db.run(`
                INSERT OR IGNORE INTO ref_detail (
                    range_key, start_bcv, end_bcv, book_id, chapter,
                    start_verse, end_verse, end_chapter, formatted
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
            `, [
                rangeKey,
                startBcv,
                endBcv,
                bookId,
                chapter,
                startVerse,
                endVerse,
                endChapter || null
            ]);
            this.db.run(`
                INSERT INTO ref_occurrences (range_key, file_path)
                VALUES (?, ?)
            `, [rangeKey, filePath]);
        } catch (e) {
            console.error(`con[VER]sum: Error inserting occurrence ${rangeKey}:`, e);
            void this.plugin.getLogger()?.error(`Failed to insert occurrence ${rangeKey} for ${filePath}`, e);
        }
    }

    upsertFileIndex(filePath: string, lastModified: number, language: string | null): void {
        if (!this.db) return;
        try {
            // Do NOT use INSERT OR REPLACE here. REPLACE deletes the existing
            // file_index row first, which cascades to ref_occurrences and wipes
            // every occurrence for that file. Use a true UPSERT instead.
            this.db.run(`
                INSERT INTO file_index (file_path, last_modified, language)
                VALUES (?, ?, ?)
                ON CONFLICT(file_path) DO UPDATE SET
                    last_modified = excluded.last_modified,
                    language = excluded.language
            `, [filePath, lastModified, language || null]);
        } catch (e) {
            console.error(`con[VER]sum: Error upserting file index ${filePath}:`, e);
            void this.plugin.getLogger()?.error(`Failed to upsert file index ${filePath}`, e);
        }
    }

    deleteFileReferences(filePath: string): void {
        if (!this.db) return;
        try {
            this.db.run(`
                DELETE FROM ref_occurrences WHERE file_path = ?
            `, [filePath]);
            this.cleanupOrphans();
        } catch (e) {
            console.error(`con[VER]sum: Error deleting file references ${filePath}:`, e);
        }
    }

    updateFormatted(rangeKey: string, formatted: string): void {
        if (!this.db) return;
        try {
            this.db.run(`
                UPDATE ref_detail 
                SET formatted = ? 
                WHERE range_key = ?
            `, [formatted, rangeKey]);
        } catch (e) {
            console.error(`con[VER]sum: Error updating formatted ${rangeKey}:`, e);
        }
    }

    cleanupOrphans(): void {
        if (!this.db) return;
        const wasInTransaction = this.inTransaction;
        if (!wasInTransaction) {
            this.db.run('BEGIN TRANSACTION');
        }
        try {
            this.db.run(`
                DELETE FROM ref_detail 
                WHERE range_key NOT IN (SELECT DISTINCT range_key FROM ref_occurrences)
            `);
            if (!wasInTransaction) {
                this.db.run('COMMIT');
            }
        } catch (e) {
            if (!wasInTransaction) {
                this.db.run('ROLLBACK');
            }
            console.error('con[VER]sum: Failed to cleanup orphans:', e);
        }
    }

    clearAllData(): void {
        if (!this.db) return;
        try {
            this.db.run('DELETE FROM ref_occurrences');
            this.db.run('DELETE FROM ref_detail');
            this.db.run('DELETE FROM file_index');
            this.db.run('DELETE FROM metadata');
            this.data = {
                version: this.data.version,
                lastUpdated: 0,
                references: {},
                fileCache: {}
            };
        } catch (e) {
            console.error('con[VER]sum: Error clearing all data:', e);
        }
    }

    // ============================================================
    // SEARCH & QUERY OPERATIONS
    // ============================================================

    searchReferences(query: string): Array<[string, ReferenceIndexEntry]> {
        if (!this.db || !query.trim()) {
            return Object.entries(this.data.references);
        }
        try {
            const q = query.toLowerCase().trim();
            const searchPattern = `%${q}%`;
            const refResult = this.db.exec(`
                SELECT DISTINCT 
                    d.range_key,
                    d.start_bcv,
                    d.end_bcv,
                    d.book_id,
                    d.chapter,
                    d.start_verse,
                    d.end_verse,
                    d.end_chapter,
                    d.formatted
                FROM ref_detail d
                WHERE d.start_bcv LIKE ? OR d.end_bcv LIKE ? OR d.range_key LIKE ? OR d.formatted LIKE ?
                ORDER BY d.book_id, d.chapter, d.start_verse
            `, [searchPattern, searchPattern, searchPattern, searchPattern]);
            const results: Array<[string, ReferenceIndexEntry]> = [];
            if (refResult.length === 0) return results;
            const columns = refResult[0].columns;
            const rows = refResult[0].values;
            const rangeKeys = rows.map(row => `'${row[columns.indexOf('range_key')] as string}'`).join(',');
            const fileMap = new Map<string, Array<{path: string, occurrences: number}>>();
            if (rangeKeys.length > 0) {
                const filesResult = this.db.exec(`
                    SELECT 
                        range_key,
                        file_path,
                        COUNT(*) as count
                    FROM ref_occurrences
                    WHERE range_key IN (${rangeKeys})
                    GROUP BY range_key, file_path
                `);
                if (filesResult.length > 0) {
                    const fileColumns = filesResult[0].columns;
                    const fileRows = filesResult[0].values;
                    for (const row of fileRows) {
                        const rangeKey = row[fileColumns.indexOf('range_key')] as string;
                        const filePath = row[fileColumns.indexOf('file_path')] as string;
                        const count = row[fileColumns.indexOf('count')] as number;
                        if (!fileMap.has(rangeKey)) {
                            fileMap.set(rangeKey, []);
                        }
                        fileMap.get(rangeKey)!.push({path: filePath, occurrences: count});
                    }
                }
            }

            for (const row of rows) {
                const rangeKey = row[columns.indexOf('range_key')] as string;
                const startBcv = row[columns.indexOf('start_bcv')] as string;
                const endBcv = row[columns.indexOf('end_bcv')] as string;
                const bookId = row[columns.indexOf('book_id')] as number;
                const chapter = row[columns.indexOf('chapter')] as number;
                const startVerse = row[columns.indexOf('start_verse')] as number;
                const endVerse = row[columns.indexOf('end_verse')] as number;
                const endChapter = row[columns.indexOf('end_chapter')] as number;
                const files = fileMap.get(rangeKey) || [];
                const totalOccurrences = files.reduce((sum, f) => sum + f.occurrences, 0);
                const entry: ReferenceIndexEntry = {
                    startBcv,
                    endBcv,
                    bcv: { bookId, chapter, startVerse, endVerse, endChapter },
                    files: files,
                    totalOccurrences
                };
                results.push([rangeKey, entry]);
            }
            return results;
        } catch (e) {
            return Object.entries(this.data.references);
        }
    }

    getGroupedReferences(): Map<number, Map<number, Array<[string, ReferenceIndexEntry, string | null]>>> {
        const grouped = new Map<number, Map<number, Array<[string, ReferenceIndexEntry, string | null]>>>();
        if (!this.db) {
            return grouped;
        }
        try {
            const result = this.db.exec(`
                SELECT 
                    d.range_key,
                    d.start_bcv,
                    d.end_bcv,
                    d.book_id,
                    d.chapter,
                    d.start_verse,
                    d.end_verse,
                    d.end_chapter,
                    d.formatted,
                    o.file_path,
                    COUNT(*) as occurrence_count
                FROM ref_detail d
                JOIN ref_occurrences o ON d.range_key = o.range_key
                GROUP BY d.range_key, o.file_path
                ORDER BY d.book_id, d.chapter, d.start_verse
            `);
            if (result.length === 0) {
                return grouped;
            }
            const columns = result[0].columns;
            const rows = result[0].values;
            const entryMap = new Map<string, {
                startBcv: string;
                endBcv: string;
                bookId: number;
                chapter: number;
                startVerse: number;
                endVerse: number;
                endChapter: number;
                formatted: string | null;
                files: Array<{path: string, occurrences: number}>;
                totalOccurrences: number;
                isWholeBook: boolean;
                displayChapter: number;
            }>();

            for (const row of rows) {
                const rangeKey = row[columns.indexOf('range_key')] as string;
                const startBcv = row[columns.indexOf('start_bcv')] as string;
                const endBcv = row[columns.indexOf('end_bcv')] as string;
                const bookId = row[columns.indexOf('book_id')] as number;
                const chapter = row[columns.indexOf('chapter')] as number;
                const startVerse = row[columns.indexOf('start_verse')] as number;
                const endVerse = row[columns.indexOf('end_verse')] as number;
                const endChapter = row[columns.indexOf('end_chapter')] as number;
                const formatted = row[columns.indexOf('formatted')] as string | null;
                const filePath = row[columns.indexOf('file_path')] as string;
                const count = row[columns.indexOf('occurrence_count')] as number;
                if (!entryMap.has(rangeKey)) {
                    const isWholeBook = isWholeBookReference(startBcv, endBcv);
                    const displayChapter = isWholeBook ? -1 : chapter;
                    entryMap.set(rangeKey, {
                        startBcv,
                        endBcv,
                        bookId,
                        chapter,
                        startVerse,
                        endVerse,
                        endChapter,
                        formatted,
                        files: [],
                        totalOccurrences: 0,
                        isWholeBook,
                        displayChapter
                    });
                }
                const entry = entryMap.get(rangeKey)!;
                entry.files.push({path: filePath, occurrences: count});
                entry.totalOccurrences += count;
            }

            for (const [, data] of entryMap) {
                const { bookId, chapter, startBcv, endBcv, startVerse, endVerse, endChapter, formatted, files, totalOccurrences, displayChapter } = data;

                const entry: ReferenceIndexEntry = {
                    startBcv,
                    endBcv,
                    bcv: { bookId, chapter, startVerse, endVerse, endChapter },
                    files,
                    totalOccurrences
                };
                const groupChapter = displayChapter;
                if (!grouped.has(bookId)) {
                    grouped.set(bookId, new Map());
                }
                const bookMap = grouped.get(bookId)!;
                if (!bookMap.has(groupChapter)) {
                    bookMap.set(groupChapter, []);
                }
                bookMap.get(groupChapter)!.push([data.startBcv + '-' + data.endBcv, entry, formatted]);
            }
            return grouped;
        } catch (e) {
            return grouped;
        }
    }

    findReferenceByStartBcv(startBcv: string, endBcv: string): ReferenceIndexEntry | null {
        const exactKey = `${startBcv}-${endBcv}`;
        if (this.data.references[exactKey]) {
            return this.data.references[exactKey];
        }
        if (!this.db) {
            const startBook = parseInt(startBcv.substring(0, 2));
            const startChapter = parseInt(startBcv.substring(2, 5));
            const startVerse = parseInt(startBcv.substring(5, 8));
            for (const [, entry] of Object.entries(this.data.references)) {
                const entryStartBook = parseInt(entry.startBcv.substring(0, 2));
                const entryStartChapter = parseInt(entry.startBcv.substring(2, 5));
                const entryStartVerse = parseInt(entry.startBcv.substring(5, 8));
                const entryEndVerse = parseInt(entry.endBcv.substring(5, 8));
                if (entryStartBook === startBook && 
                    entryStartChapter === startChapter && 
                    startVerse >= entryStartVerse && 
                    startVerse <= entryEndVerse) {
                    return entry;
                }
            }
            return null;
        }

        try {
            const startBook = parseInt(startBcv.substring(0, 2));
            const startChapter = parseInt(startBcv.substring(2, 5));
            const startVerse = parseInt(startBcv.substring(5, 8));
            const refResult = this.db.exec(`
                SELECT 
                    d.range_key,
                    d.start_bcv,
                    d.end_bcv,
                    d.book_id,
                    d.chapter,
                    d.start_verse,
                    d.end_verse,
                    d.end_chapter,
                    d.formatted
                FROM ref_detail d
                WHERE d.book_id = ? AND d.chapter = ? AND d.start_verse <= ? AND d.end_verse >= ?
                LIMIT 1
            `, [startBook, startChapter, startVerse, startVerse]);
            if (refResult.length === 0 || refResult[0].values.length === 0) return null;
            const columns = refResult[0].columns;
            const row = refResult[0].values[0];
            const rangeKey = row[columns.indexOf('range_key')] as string;
            const startBcvResult = row[columns.indexOf('start_bcv')] as string;
            const endBcvResult = row[columns.indexOf('end_bcv')] as string;
            const bookId = row[columns.indexOf('book_id')] as number;
            const chapter = row[columns.indexOf('chapter')] as number;
            const startVerseResult = row[columns.indexOf('start_verse')] as number;
            const endVerseResult = row[columns.indexOf('end_verse')] as number;
            const endChapter = row[columns.indexOf('end_chapter')] as number;
            const filesResult = this.db.exec(`
                SELECT file_path, COUNT(*) as count
                FROM ref_occurrences
                WHERE range_key = ?
                GROUP BY file_path
            `, [rangeKey]);
            const files: Array<{path: string, occurrences: number}> = [];
            let totalOccurrences = 0;
            if (filesResult.length > 0) {
                const fileColumns = filesResult[0].columns;
                for (const row2 of filesResult[0].values) {
                    const path = row2[fileColumns.indexOf('file_path')] as string;
                    const count = row2[fileColumns.indexOf('count')] as number;
                    files.push({path, occurrences: count});
                    totalOccurrences += count;
                }
            }
            const entry: ReferenceIndexEntry = {
                startBcv: startBcvResult,
                endBcv: endBcvResult,
                bcv: { bookId, chapter, startVerse: startVerseResult, endVerse: endVerseResult, endChapter },
                files,
                totalOccurrences
            };
            return entry;
        } catch (e) {
            return null;
        }
    }

    findReferencesContainingRange(
        refStartBcv: string,
        refEndBcv: string
    ): Array<[string, ReferenceIndexEntry]> {
        const results: Array<[string, ReferenceIndexEntry]> = [];
        const refStartBook = parseInt(refStartBcv.substring(0, 2));
        const refEndBook = parseInt(refEndBcv.substring(0, 2));
        const refStartChapter = parseInt(refStartBcv.substring(2, 5));
        const refEndChapter = parseInt(refEndBcv.substring(2, 5));
        const refStartVerse = parseInt(refStartBcv.substring(5, 8));
        const refEndVerse = parseInt(refEndBcv.substring(5, 8));
        for (const [key, entry] of Object.entries(this.data.references)) {
            const entryStartBook = parseInt(entry.startBcv.substring(0, 2));
            const entryEndBook = parseInt(entry.endBcv.substring(0, 2));
            const entryStartChapter = parseInt(entry.startBcv.substring(2, 5));
            const entryEndChapter = parseInt(entry.endBcv.substring(2, 5));
            const entryStartVerse = parseInt(entry.startBcv.substring(5, 8));
            const entryEndVerse = parseInt(entry.endBcv.substring(5, 8));
            if (entryStartBook !== refStartBook || entryEndBook !== refEndBook) {
                continue;
            }
            if (entryStartChapter > refStartChapter) continue;
            if (entryEndChapter < refEndChapter) continue;
            if (entryStartChapter === refStartChapter && entryStartVerse > refStartVerse) continue;
            if (entryEndChapter === refEndChapter && entryEndVerse < refEndVerse) continue;
            results.push([key, entry]);
        }
        return results;
    }

    // ============================================================
    // LIFECYCLE
    // ============================================================

    async close(): Promise<void> {
        if (this.db) {
            if (this.inTransaction) {
                try {
                    await this.commitTransaction(true);
                } catch {
                    this.rollbackTransaction();
                }
            }
            try {
                this.db.run('VACUUM');
            } catch {
            }
            await this.saveToDisk();
            this.db.close();
            this.db = null;
            this.initialized = false;
        }
    }
}

// engine-wrapper.ts

import * as wasmModule from './engine.js';
import wasmBinary from './engine_bg.wasm';

let engineInitialized = false;

const enginePool = new Map<string, any>();
let cachedLanguages: any[] | null = null;

export function clearEnginePool(): void {
    enginePool.clear();
    cachedLanguages = null;
}

export async function initEngine(): Promise<void> {
    if (engineInitialized) return;
    
    try {
        await wasmModule.default({ module_or_path: wasmBinary });
        engineInitialized = true;
    } catch (e) {
        console.error('con[VER]sum: Failed to initialize WASM engine:', e);
        throw e;
    }
}

export function prewarmEngines(sourceLanguage: string, outputLanguage: string): void {
    if (!engineInitialized) return;
    
    const formats: Array<'full' | 'standard' | 'official'> = ['full', 'standard', 'official'];
    for (const format of formats) {
        getOrCreateEngine(sourceLanguage, outputLanguage, format);
    }
}

function getOrCreateEngine(
    language: string,
    outputLanguage: string,
    format: 'full' | 'standard' | 'official'
): any {
    const key = `${language}-${outputLanguage}-${format}`;
    if (enginePool.has(key)) {
        // LRU: move to end
        const existing = enginePool.get(key);
        enginePool.delete(key);
        enginePool.set(key, existing);
        return existing;
    }
    // Cap pool size to limit RAM on low-end devices.
    if (enginePool.size >= 3) {
        const oldestKey = enginePool.keys().next().value;
        if (oldestKey) enginePool.delete(oldestKey);
    }
    try {
        const engine = new wasmModule.TravertureEngine(language, language, format, false);
        enginePool.set(key, engine);
        return engine;
    } catch {
        return null;
    }
}

export function isWholeBookReference(startBcv: string, endBcv: string): boolean {
    if (!startBcv || !endBcv || startBcv.length < 8 || endBcv.length < 8) {
        return false;
    }
    
    const startBook = parseInt(startBcv.substring(0, 2));
    const endBook = parseInt(endBcv.substring(0, 2));
    if (startBook !== endBook) {
        return false;
    }
    
    const startChapter = parseInt(startBcv.substring(2, 5));
    const startVerse = parseInt(startBcv.substring(5, 8));
    if (startChapter !== 1 || startVerse !== 1) {
        return false;
    }
    
    const endChapter = parseInt(endBcv.substring(2, 5));
    const endVerse = parseInt(endBcv.substring(5, 8));
    const totalChapters = getChapterCount(startBook);
    
    if (endChapter !== totalChapters) {
        return false;
    }
    
    const lastChapterVerses = getVerseCount(startBook, totalChapters);
    return endVerse === lastChapterVerses;
}

export function isEngineReady(): boolean {
    return engineInitialized;
}

export function getChapterCount(bookId: number): number {
    if (!engineInitialized) {
        return 0;
    }
    try {
        return wasmModule.TravertureEngine.get_chapter_count(bookId);
    } catch {
        return 0;
    }
}

export function getVerseCount(bookId: number, chapter: number): number {
    if (!engineInitialized) {
        return 0;
    }
    try {
        return wasmModule.TravertureEngine.get_verse_count(bookId, chapter);
    } catch {
        return 1;
    }
}

export function getBookName(
    bookNumber: number,
    langCode: string,
    format: 'full' | 'standard' | 'official' = 'full',
    capitalize: boolean = false
): string {
    if (!engineInitialized) {
        return '';
    }
    try {
        return wasmModule.TravertureEngine.get_book_name(bookNumber, langCode, format, capitalize);
    } catch {
        return '';
    }
}

export function getLangSymbol(langCode: string): string {
    if (!engineInitialized) {
        return 'E';
    }
    try {
        return wasmModule.TravertureEngine.get_lang_symbol(langCode);
    } catch {
        return 'E';
    }
}

export function getAvailableLanguages(): any[] {
    if (!engineInitialized) {
        return [];
    }
    if (cachedLanguages) {
        return cachedLanguages;
    }
    
    try {
        const json = wasmModule.TravertureEngine.get_available_languages();
        const parsed = JSON.parse(json);
        cachedLanguages = parsed
            .filter((lang: any) => lang.code !== 'ase' && lang.language_code !== 'ase')
            .map((lang: any) => ({
                code: lang.code || lang.language_code,
                language_code: lang.code || lang.language_code,
                suffix: lang.symbol || lang.suffix || '',
                language_name: lang.vernacular_name || lang.language_name || lang.vernacularName || lang.languageName,
                vernacular_name: lang.vernacular_name || lang.language_name || lang.vernacularName || lang.languageName,
                vernacularName: lang.language_name || lang.vernacularName || lang.languageName,
                englishName: lang.english_name || lang.englishName
            }));
        return cachedLanguages;
    } catch {
        return [];
    }
}

export function resolveLanguage(input: string): string | null {
    if (!input) return null;
    const trimmed = input.trim();
    if (!trimmed) return null;
    
    const available = getAvailableLanguages();
    const lower = trimmed.toLowerCase();
    
    const byCode = available.find(l => l.code.toLowerCase() === lower);
    if (byCode) return byCode.code;
    
    const byName = available.find(l => l.language_name.toLowerCase() === lower);
    if (byName) return byName.code;
    
    const byEnglish = available.find(l => l.englishName && l.englishName.toLowerCase() === lower);
    if (byEnglish) return byEnglish.code;
    
    return null;
}

export function parseReferences(
    text: string,
    sourceLanguage: string,
    outputLanguage: string,
    nameFormat: 'full' | 'standard' | 'official' = 'full',
    capitalize: boolean = false
): any[] | null {
    if (!text || text.trim().length === 0) return [];
    const resolvedSource = resolveLanguage(sourceLanguage) || sourceLanguage;
    const key = `${resolvedSource}-${outputLanguage}-${nameFormat}`;
    let engine = getOrCreateEngine(resolvedSource, outputLanguage, nameFormat);
    if (!engine) return null;
    
    try {
        const result = engine.parse(resolvedSource, outputLanguage, nameFormat, capitalize, text);
        return JSON.parse(result);
    } catch {
        // Auto-heal: evict panicked/corrupted engine and retry with fresh instance
        enginePool.delete(key);
        try {
            const freshEngine = new wasmModule.TravertureEngine(resolvedSource, resolvedSource, nameFormat, false);
            enginePool.set(key, freshEngine);
            const retryResult = freshEngine.parse(resolvedSource, outputLanguage, nameFormat, capitalize, text);
            return JSON.parse(retryResult);
        } catch {
            return null;
        }
    }
}

export function decodeScriptures(
    ranges: Array<[string, string]>,
    outputLanguage: string,
    nameFormat: 'full' | 'standard' | 'official' = 'full'
): string[] | null {
    const engine = getOrCreateEngine(outputLanguage, outputLanguage, nameFormat);
    if (!engine) return null;
    
    try {
        const rangesJson = JSON.stringify(ranges);
        const result = engine.decode_scriptures(rangesJson);
        return JSON.parse(result);
    } catch {
        return null;
    }
}

export function getEngineVersion(): string {
    if (!engineInitialized) {
        return 'Engine not initialized';
    }
    try {
        return wasmModule.TravertureEngine.get_version();
    } catch {
        return 'Unknown';
    }
}

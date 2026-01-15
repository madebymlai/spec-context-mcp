import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { glob } from 'glob';
import Ignore from 'ignore';
import type { VectorDatabase, VectorDocument } from './vectordb/types.js';
import type { EmbeddingProvider } from './embedding/types.js';
import type { Splitter, CodeChunk } from './splitter/types.js';
import type { SemanticSearchResult } from './types.js';
import { FileSynchronizer } from './sync/synchronizer.js';

export interface IndexingProgress {
    phase: 'scanning' | 'splitting' | 'embedding' | 'inserting' | 'done';
    current: number;
    total: number;
    currentFile?: string;
}

export interface IndexingResult {
    indexedFiles: number;
    totalChunks: number;
    collectionName: string;
}

export interface SyncResult {
    added: number;
    removed: number;
    modified: number;
    totalChunks: number;
}

// Language detection by file extension
const EXTENSION_TO_LANGUAGE: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.py': 'python',
    '.java': 'java',
    '.go': 'go',
    '.rs': 'rust',
    '.cpp': 'cpp',
    '.c': 'c',
    '.h': 'c',
    '.hpp': 'cpp',
    '.cs': 'csharp',
    '.rb': 'ruby',
    '.php': 'php',
    '.swift': 'swift',
    '.kt': 'kotlin',
    '.scala': 'scala',
    '.md': 'markdown',
    '.json': 'json',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.toml': 'toml',
    '.xml': 'xml',
    '.html': 'html',
    '.css': 'css',
    '.scss': 'scss',
    '.sql': 'sql',
    '.sh': 'shell',
    '.bash': 'shell',
    '.zsh': 'shell',
};

// Default ignore patterns
const DEFAULT_IGNORE = [
    'node_modules/**',
    '.git/**',
    'dist/**',
    'build/**',
    '__pycache__/**',
    '*.pyc',
    '.env*',
    '*.lock',
    'package-lock.json',
    'yarn.lock',
    '.DS_Store',
    'coverage/**',
    '.next/**',
    '.nuxt/**',
    'vendor/**',
    'target/**',  // Rust
    'bin/**',
    'obj/**',     // C#
];

export class Context {
    private vectorDb: VectorDatabase;
    private embedding: EmbeddingProvider;
    private splitter: Splitter;

    constructor(
        vectorDb: VectorDatabase,
        embedding: EmbeddingProvider,
        splitter: Splitter
    ) {
        this.vectorDb = vectorDb;
        this.embedding = embedding;
        this.splitter = splitter;
    }

    /**
     * Get collection name for a project path
     */
    getCollectionName(projectPath: string): string {
        const normalizedPath = path.resolve(projectPath);
        const hash = crypto.createHash('md5').update(normalizedPath).digest('hex');
        return `code_chunks_${hash.substring(0, 8)}`;
    }

    /**
     * Index a codebase
     */
    async indexCodebase(
        projectPath: string,
        options?: {
            force?: boolean;
            customExtensions?: string[];
            ignorePatterns?: string[];
            onProgress?: (progress: IndexingProgress) => void;
        }
    ): Promise<IndexingResult> {
        const collectionName = this.getCollectionName(projectPath);
        const dimension = this.embedding.getDimension();

        // Check if collection exists
        const exists = await this.vectorDb.hasCollection(collectionName);
        if (exists && !options?.force) {
            console.log(`[Context] Collection ${collectionName} already exists. Use force=true to re-index.`);
            return { indexedFiles: 0, totalChunks: 0, collectionName };
        }

        // Drop existing collection if force
        if (exists && options?.force) {
            await this.vectorDb.dropCollection(collectionName);
        }

        // Create collection
        await this.vectorDb.createCollection(collectionName, dimension);

        // Scan files
        options?.onProgress?.({ phase: 'scanning', current: 0, total: 0 });
        const files = await this.scanFiles(projectPath, options?.customExtensions, options?.ignorePatterns);

        if (files.length === 0) {
            console.log('[Context] No files to index');
            return { indexedFiles: 0, totalChunks: 0, collectionName };
        }

        // Process files
        const allChunks: VectorDocument[] = [];
        let processedFiles = 0;

        for (const file of files) {
            options?.onProgress?.({
                phase: 'splitting',
                current: processedFiles,
                total: files.length,
                currentFile: file,
            });

            try {
                const content = await fs.promises.readFile(file, 'utf-8');
                const ext = path.extname(file);
                const language = EXTENSION_TO_LANGUAGE[ext] || 'text';
                const relativePath = path.relative(projectPath, file);

                // Split into chunks
                const chunks = await this.splitter.split(content, language, relativePath);

                // Create documents
                for (let i = 0; i < chunks.length; i++) {
                    const chunk = chunks[i];
                    const id = `${relativePath}:${chunk.metadata.startLine}:${chunk.metadata.endLine}:${i}`;

                    allChunks.push({
                        id,
                        vector: [], // Will be filled during embedding
                        content: chunk.content,
                        relativePath,
                        startLine: chunk.metadata.startLine,
                        endLine: chunk.metadata.endLine,
                        fileExtension: ext,
                        metadata: {
                            language,
                            projectPath,
                            chunkIndex: i,
                        },
                    });
                }
            } catch (error) {
                console.warn(`[Context] Failed to process ${file}:`, error);
            }

            processedFiles++;
        }

        if (allChunks.length === 0) {
            console.log('[Context] No chunks generated');
            return { indexedFiles: processedFiles, totalChunks: 0, collectionName };
        }

        // Generate embeddings in batches
        options?.onProgress?.({ phase: 'embedding', current: 0, total: allChunks.length });

        const batchSize = 50;
        for (let i = 0; i < allChunks.length; i += batchSize) {
            const batch = allChunks.slice(i, i + batchSize);
            const texts = batch.map((c) => c.content);

            const embeddings = await this.embedding.embed(texts);

            for (let j = 0; j < batch.length; j++) {
                batch[j].vector = embeddings[j];
            }

            options?.onProgress?.({
                phase: 'embedding',
                current: Math.min(i + batchSize, allChunks.length),
                total: allChunks.length,
            });
        }

        // Insert into vector database
        options?.onProgress?.({ phase: 'inserting', current: 0, total: allChunks.length });
        await this.vectorDb.insert(collectionName, allChunks);

        options?.onProgress?.({ phase: 'done', current: allChunks.length, total: allChunks.length });

        console.log(`[Context] Indexed ${processedFiles} files with ${allChunks.length} chunks`);

        return {
            indexedFiles: processedFiles,
            totalChunks: allChunks.length,
            collectionName,
        };
    }

    /**
     * Search for code
     */
    async search(
        projectPath: string,
        query: string,
        options?: {
            limit?: number;
            extensionFilter?: string[];
        }
    ): Promise<SemanticSearchResult[]> {
        const collectionName = this.getCollectionName(projectPath);

        // Check if collection exists
        const exists = await this.vectorDb.hasCollection(collectionName);
        if (!exists) {
            throw new Error(`Codebase not indexed. Run index_codebase first.`);
        }

        // Generate query embedding
        const queryVector = await this.embedding.embedSingle(query);

        // Build filter
        let filterExpr: string | undefined;
        if (options?.extensionFilter && options.extensionFilter.length > 0) {
            const extensions = options.extensionFilter.map((e) => e.startsWith('.') ? e : `.${e}`);
            filterExpr = `fileExtension in [${extensions.map((e) => `"${e}"`).join(', ')}]`;
        }

        // Search
        const results = await this.vectorDb.search(collectionName, queryVector, {
            topK: options?.limit ?? 10,
            filterExpr,
        });

        return results.map((r) => ({
            content: r.document.content,
            relativePath: r.document.relativePath,
            startLine: r.document.startLine,
            endLine: r.document.endLine,
            language: (r.document.metadata.language as string) || 'text',
            score: r.score,
        }));
    }

    /**
     * Clear index for a project
     */
    async clearIndex(projectPath: string): Promise<void> {
        const collectionName = this.getCollectionName(projectPath);
        await this.vectorDb.dropCollection(collectionName);
        console.log(`[Context] Cleared index for ${projectPath}`);
    }

    /**
     * Check if a codebase is indexed
     */
    async isIndexed(projectPath: string): Promise<boolean> {
        const collectionName = this.getCollectionName(projectPath);
        return this.vectorDb.hasCollection(collectionName);
    }

    /**
     * Sync codebase - incremental update of changed files only
     */
    async syncCodebase(
        projectPath: string,
        options?: {
            ignorePatterns?: string[];
            onProgress?: (progress: IndexingProgress) => void;
        }
    ): Promise<SyncResult> {
        const collectionName = this.getCollectionName(projectPath);

        // Check if collection exists
        const exists = await this.vectorDb.hasCollection(collectionName);
        if (!exists) {
            // If not indexed, do full index
            const result = await this.indexCodebase(projectPath, {
                force: true,
                ignorePatterns: options?.ignorePatterns,
                onProgress: options?.onProgress,
            });
            return {
                added: result.indexedFiles,
                removed: 0,
                modified: 0,
                totalChunks: result.totalChunks,
            };
        }

        // Initialize synchronizer
        const synchronizer = new FileSynchronizer(projectPath, options?.ignorePatterns || []);
        await synchronizer.initialize();

        // Check for changes
        const changes = await synchronizer.checkForChanges();

        if (changes.added.length === 0 && changes.removed.length === 0 && changes.modified.length === 0) {
            return { added: 0, removed: 0, modified: 0, totalChunks: 0 };
        }

        // Process removed files - delete their chunks
        if (changes.removed.length > 0) {
            const idsToDelete: string[] = [];
            for (const file of changes.removed) {
                // We need to query for chunks with this relativePath
                const results = await this.vectorDb.query(
                    collectionName,
                    `relativePath == "${file}"`,
                    ['id']
                );
                for (const r of results) {
                    if (r.id) idsToDelete.push(r.id as string);
                }
            }
            if (idsToDelete.length > 0) {
                await this.vectorDb.delete(collectionName, idsToDelete);
            }
        }

        // Process modified files - delete old chunks, add new ones
        if (changes.modified.length > 0) {
            const idsToDelete: string[] = [];
            for (const file of changes.modified) {
                const results = await this.vectorDb.query(
                    collectionName,
                    `relativePath == "${file}"`,
                    ['id']
                );
                for (const r of results) {
                    if (r.id) idsToDelete.push(r.id as string);
                }
            }
            if (idsToDelete.length > 0) {
                await this.vectorDb.delete(collectionName, idsToDelete);
            }
        }

        // Process added and modified files - create new chunks
        const filesToProcess = [...changes.added, ...changes.modified];
        const newChunks: VectorDocument[] = [];

        for (const relativePath of filesToProcess) {
            const fullPath = path.join(projectPath, relativePath);
            try {
                const content = await fs.promises.readFile(fullPath, 'utf-8');
                const ext = path.extname(relativePath);
                const language = EXTENSION_TO_LANGUAGE[ext] || 'text';

                const chunks = await this.splitter.split(content, language, relativePath);

                for (let i = 0; i < chunks.length; i++) {
                    const chunk = chunks[i];
                    const id = `${relativePath}:${chunk.metadata.startLine}:${chunk.metadata.endLine}:${i}`;

                    newChunks.push({
                        id,
                        vector: [],
                        content: chunk.content,
                        relativePath,
                        startLine: chunk.metadata.startLine,
                        endLine: chunk.metadata.endLine,
                        fileExtension: ext,
                        metadata: {
                            language,
                            projectPath,
                            chunkIndex: i,
                        },
                    });
                }
            } catch (error) {
                console.warn(`[Context] Failed to process ${fullPath}:`, error);
            }
        }

        // Generate embeddings for new chunks
        if (newChunks.length > 0) {
            const batchSize = 50;
            for (let i = 0; i < newChunks.length; i += batchSize) {
                const batch = newChunks.slice(i, i + batchSize);
                const texts = batch.map((c) => c.content);
                const embeddings = await this.embedding.embed(texts);

                for (let j = 0; j < batch.length; j++) {
                    batch[j].vector = embeddings[j];
                }
            }

            // Insert new chunks
            await this.vectorDb.insert(collectionName, newChunks);
        }

        console.log(`[Context] Synced: ${changes.added.length} added, ${changes.removed.length} removed, ${changes.modified.length} modified`);

        return {
            added: changes.added.length,
            removed: changes.removed.length,
            modified: changes.modified.length,
            totalChunks: newChunks.length,
        };
    }

    /**
     * Scan files in a directory
     */
    private async scanFiles(
        projectPath: string,
        customExtensions?: string[],
        ignorePatterns?: string[]
    ): Promise<string[]> {
        // Build ignore filter
        const ig = Ignore.default();

        // Add default patterns
        ig.add(DEFAULT_IGNORE);

        // Add custom patterns
        if (ignorePatterns) {
            ig.add(ignorePatterns);
        }

        // Try to read .gitignore
        const gitignorePath = path.join(projectPath, '.gitignore');
        if (fs.existsSync(gitignorePath)) {
            const gitignore = await fs.promises.readFile(gitignorePath, 'utf-8');
            ig.add(gitignore);
        }

        // Determine extensions to search
        const defaultExtensions = Object.keys(EXTENSION_TO_LANGUAGE);
        const extensions = customExtensions || defaultExtensions;
        const extPattern = extensions.length > 1
            ? `**/*{${extensions.join(',')}}`
            : `**/*${extensions[0]}`;

        // Find files
        const files = await glob(extPattern, {
            cwd: projectPath,
            nodir: true,
            absolute: true,
            ignore: DEFAULT_IGNORE,
        });

        // Filter with ignore patterns
        const relativePaths = files.map((f) => path.relative(projectPath, f));
        const filteredPaths = ig.filter(relativePaths);

        return filteredPaths.map((p: string) => path.join(projectPath, p));
    }
}

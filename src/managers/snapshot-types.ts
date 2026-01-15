// Codebase status types

interface CodebaseInfoBase {
    lastUpdated: string;
}

export interface CodebaseInfoIndexing extends CodebaseInfoBase {
    status: 'indexing';
    indexingPercentage: number;
}

export interface CodebaseInfoIndexed extends CodebaseInfoBase {
    status: 'indexed';
    indexedFiles: number;
    totalChunks: number;
    indexStatus: 'completed' | 'limit_reached';
}

export interface CodebaseInfoIndexFailed extends CodebaseInfoBase {
    status: 'indexfailed';
    errorMessage: string;
    lastAttemptedPercentage?: number;
}

export type CodebaseInfo = CodebaseInfoIndexing | CodebaseInfoIndexed | CodebaseInfoIndexFailed;

export interface CodebaseSnapshot {
    formatVersion: 'v2';
    codebases: Record<string, CodebaseInfo>;
    lastUpdated: string;
}

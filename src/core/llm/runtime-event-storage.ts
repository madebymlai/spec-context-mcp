export interface RuntimeEventStorage {
    exists(path: string): boolean;
    readFile(path: string): string;
    ensureDirectory(path: string): Promise<void>;
    appendFile(path: string, content: string): Promise<void>;
}

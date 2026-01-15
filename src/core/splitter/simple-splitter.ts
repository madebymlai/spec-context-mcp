import type { Splitter, CodeChunk } from './types.js';

/**
 * Simple character-based code splitter.
 * Splits code at natural boundaries (blank lines, function/class definitions)
 * without requiring langchain or tree-sitter dependencies.
 */
export class SimpleCodeSplitter implements Splitter {
    private chunkSize: number;
    private chunkOverlap: number;

    constructor(chunkSize: number = 2000, chunkOverlap: number = 200) {
        this.chunkSize = chunkSize;
        this.chunkOverlap = chunkOverlap;
    }

    async split(code: string, language: string, filePath?: string): Promise<CodeChunk[]> {
        const lines = code.split('\n');
        const chunks: CodeChunk[] = [];

        let currentChunk = '';
        let chunkStartLine = 1;
        let currentLine = 1;

        for (const line of lines) {
            const lineWithNewline = line + '\n';

            // Check if adding this line would exceed chunk size
            if (currentChunk.length + lineWithNewline.length > this.chunkSize && currentChunk.length > 0) {
                // Try to split at a natural boundary
                const boundary = this.findNaturalBoundary(currentChunk);

                if (boundary > 0 && boundary < currentChunk.length - 100) {
                    // Split at natural boundary
                    const beforeBoundary = currentChunk.slice(0, boundary);
                    const afterBoundary = currentChunk.slice(boundary);

                    chunks.push(this.createChunk(
                        beforeBoundary.trim(),
                        chunkStartLine,
                        chunkStartLine + this.countLines(beforeBoundary) - 1,
                        language,
                        filePath
                    ));

                    currentChunk = afterBoundary + lineWithNewline;
                    chunkStartLine = currentLine - this.countLines(afterBoundary) + 1;
                } else {
                    // No good boundary, split at current position
                    chunks.push(this.createChunk(
                        currentChunk.trim(),
                        chunkStartLine,
                        currentLine - 1,
                        language,
                        filePath
                    ));

                    // Add overlap from end of previous chunk
                    const overlap = this.getOverlapText(currentChunk);
                    currentChunk = overlap + lineWithNewline;
                    chunkStartLine = currentLine - this.countLines(overlap);
                }
            } else {
                currentChunk += lineWithNewline;
            }

            currentLine++;
        }

        // Add the last chunk
        if (currentChunk.trim().length > 0) {
            chunks.push(this.createChunk(
                currentChunk.trim(),
                chunkStartLine,
                lines.length,
                language,
                filePath
            ));
        }

        return chunks;
    }

    setChunkSize(chunkSize: number): void {
        this.chunkSize = chunkSize;
    }

    setChunkOverlap(chunkOverlap: number): void {
        this.chunkOverlap = chunkOverlap;
    }

    private createChunk(
        content: string,
        startLine: number,
        endLine: number,
        language?: string,
        filePath?: string
    ): CodeChunk {
        return {
            content,
            metadata: {
                startLine: Math.max(1, startLine),
                endLine: Math.max(1, endLine),
                language,
                filePath,
            },
        };
    }

    private findNaturalBoundary(text: string): number {
        // Look for natural split points (in order of preference)
        const patterns = [
            /\n\n(?=(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var|def|async def|impl|struct|enum)\s)/g,  // Before declarations
            /\n\n(?=\s*(?:\/\/|#|\/\*|\"\"\"|\'\'\')\s*[A-Z])/g,  // Before comment blocks
            /\n\n+/g,  // Double newlines (blank lines)
            /\n(?=\s*})\n/g,  // After closing braces
        ];

        for (const pattern of patterns) {
            const matches = [...text.matchAll(pattern)];
            if (matches.length > 0) {
                // Find the match closest to the middle
                const targetPos = text.length * 0.6;
                let closest = matches[0];
                let minDist = Math.abs((closest.index ?? 0) - targetPos);

                for (const match of matches) {
                    const dist = Math.abs((match.index ?? 0) - targetPos);
                    if (dist < minDist) {
                        minDist = dist;
                        closest = match;
                    }
                }

                return (closest.index ?? 0) + closest[0].indexOf('\n') + 1;
            }
        }

        return -1;
    }

    private getOverlapText(text: string): string {
        if (this.chunkOverlap <= 0) return '';

        const lines = text.split('\n');
        let overlap = '';

        for (let i = lines.length - 1; i >= 0 && overlap.length < this.chunkOverlap; i--) {
            overlap = lines[i] + '\n' + overlap;
        }

        return overlap.slice(0, this.chunkOverlap);
    }

    private countLines(text: string): number {
        return text.split('\n').length;
    }
}

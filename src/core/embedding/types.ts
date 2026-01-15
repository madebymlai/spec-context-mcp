export interface EmbeddingProvider {
    embed(texts: string[]): Promise<number[][]>;
    embedSingle(text: string): Promise<number[]>;
    getDimension(): number;
}

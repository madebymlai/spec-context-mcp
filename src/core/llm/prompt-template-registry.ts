import { createHash } from 'crypto';

export type PromptSegmentKind = 'tools' | 'system' | 'examples' | 'dynamic' | string;

export interface PromptSegment {
    kind: PromptSegmentKind;
    content: string;
    stable: boolean;
}

export interface PromptTemplate {
    templateId: string;
    version: string;
    segments: PromptSegment[];
}

export interface CompiledPrompt {
    text: string;
    stablePrefix: string;
    stablePrefixHash: string;
    fullPromptHash: string;
}

const SEGMENT_ORDER: PromptSegmentKind[] = ['tools', 'system', 'examples', 'dynamic'];

function hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function segmentWeight(kind: PromptSegmentKind): number {
    const idx = SEGMENT_ORDER.indexOf(kind);
    return idx >= 0 ? idx : SEGMENT_ORDER.length;
}

export class PromptTemplateRegistry {
    private readonly templates = new Map<string, PromptTemplate>();

    register(template: PromptTemplate): void {
        this.templates.set(this.key(template.templateId, template.version), template);
    }

    get(templateId: string, version: string): PromptTemplate | null {
        return this.templates.get(this.key(templateId, version)) ?? null;
    }

    compile(templateId: string, version: string, dynamicTail?: string): CompiledPrompt {
        const template = this.get(templateId, version);
        if (!template) {
            throw new Error(`Prompt template not found: ${templateId}@${version}`);
        }

        const sorted = [...template.segments].sort((a, b) => segmentWeight(a.kind) - segmentWeight(b.kind));
        const segments = sorted.map(segment => ({ ...segment }));

        if (dynamicTail && dynamicTail.trim().length > 0) {
            segments.push({ kind: 'dynamic', stable: false, content: dynamicTail });
        }

        const text = segments.map(segment => segment.content).join('\n\n').trim();
        const stablePrefix = segments
            .filter(segment => segment.stable)
            .map(segment => segment.content)
            .join('\n\n')
            .trim();

        return {
            text,
            stablePrefix,
            stablePrefixHash: hash(stablePrefix),
            fullPromptHash: hash(text),
        };
    }

    private key(templateId: string, version: string): string {
        return `${templateId}@${version}`;
    }
}

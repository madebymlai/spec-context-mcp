export type SchemaValidator<T = unknown> = (payload: unknown) => payload is T;

interface SchemaEntry<T = unknown> {
    schemaId: string;
    schemaVersion: string;
    validate: SchemaValidator<T>;
}

export class SchemaRegistry {
    private readonly byType = new Map<string, SchemaEntry[]>();

    register<T>(type: string, schemaId: string, schemaVersion: string, validate: SchemaValidator<T>): void {
        const entry: SchemaEntry<T> = { schemaId, schemaVersion, validate };
        const entries = this.byType.get(type) ?? [];
        const filtered = entries.filter(existing => !(existing.schemaId === schemaId && existing.schemaVersion === schemaVersion));
        filtered.push(entry);
        this.byType.set(type, filtered);
    }

    validate(type: string, payload: unknown, schemaVersion?: string): boolean {
        const entry = this.resolve(type, schemaVersion);
        if (!entry) {
            return false;
        }
        return entry.validate(payload);
    }

    assert(type: string, payload: unknown, schemaVersion?: string): void {
        if (!this.validate(type, payload, schemaVersion)) {
            const versionPart = schemaVersion ? ` (schema=${schemaVersion})` : '';
            throw new Error(`Schema validation failed for ${type}${versionPart}`);
        }
    }

    latestVersion(type: string): string | null {
        const entries = this.byType.get(type);
        if (!entries || entries.length === 0) {
            return null;
        }
        return entries[entries.length - 1]!.schemaVersion;
    }

    private resolve(type: string, schemaVersion?: string): SchemaEntry | null {
        const entries = this.byType.get(type);
        if (!entries || entries.length === 0) {
            return null;
        }

        if (!schemaVersion) {
            return entries[entries.length - 1] ?? null;
        }

        return entries.find(entry => entry.schemaVersion === schemaVersion) ?? null;
    }
}

import {
  PROVIDER_CATALOG,
  type CanonicalProvider,
  type DispatchRole,
  resolveDispatchProvider,
} from '../../config/discipline.js';
import type { ComplexityLevel, RoutingTableConfig, RoutingTableEntry } from './types.js';

const DEFAULT_ROUTING_TABLE_CONFIG: RoutingTableConfig = {
  simple: 'codex',
  moderate: 'claude',
  complex: 'claude',
};

function parseConfiguredProvider(value: string, envVarName: string): CanonicalProvider {
  const resolvedProvider = resolveDispatchProvider(value);
  if (!resolvedProvider) {
    throw new Error(`${envVarName} must reference a known provider; received "${value}"`);
  }
  return resolvedProvider;
}

export class RoutingTable {
  private readonly config: RoutingTableConfig;

  constructor(config: RoutingTableConfig) {
    this.assertKnownProvider('simple', config.simple);
    this.assertKnownProvider('moderate', config.moderate);
    this.assertKnownProvider('complex', config.complex);
    this.config = config;
  }

  static fromEnvOrDefault(): RoutingTable {
    const simple = process.env.SPEC_CONTEXT_ROUTE_SIMPLE?.trim();
    const moderate = process.env.SPEC_CONTEXT_ROUTE_MODERATE?.trim();
    const complex = process.env.SPEC_CONTEXT_ROUTE_COMPLEX?.trim();

    return new RoutingTable({
      simple: simple
        ? parseConfiguredProvider(simple, 'SPEC_CONTEXT_ROUTE_SIMPLE')
        : DEFAULT_ROUTING_TABLE_CONFIG.simple,
      moderate: moderate
        ? parseConfiguredProvider(moderate, 'SPEC_CONTEXT_ROUTE_MODERATE')
        : DEFAULT_ROUTING_TABLE_CONFIG.moderate,
      complex: complex
        ? parseConfiguredProvider(complex, 'SPEC_CONTEXT_ROUTE_COMPLEX')
        : DEFAULT_ROUTING_TABLE_CONFIG.complex,
    });
  }

  resolve(level: ComplexityLevel, role: DispatchRole): RoutingTableEntry {
    const provider = this.config[level];
    return {
      provider,
      cli: PROVIDER_CATALOG[provider][role],
      role,
    };
  }

  private assertKnownProvider(level: ComplexityLevel, provider: CanonicalProvider): void {
    if (!(provider in PROVIDER_CATALOG)) {
      throw new Error(`Routing config for ${level} references unknown provider "${provider}"`);
    }
  }
}

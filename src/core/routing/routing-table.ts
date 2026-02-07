import {
  PROVIDER_CATALOG,
  type CanonicalProvider,
  type DispatchRole,
  resolveAgentCli,
  resolveDispatchProvider,
} from '../../config/discipline.js';
import type { ComplexityLevel, RoutingTableConfig, RoutingTableEntry } from './types.js';

const DEFAULT_ROUTING_TABLE_CONFIG: RoutingTableConfig = {
  simple: 'codex',
  moderate: 'claude',
  complex: 'claude',
};

const ESCALATION_ORDER: Record<ComplexityLevel, ComplexityLevel[]> = {
  simple: ['simple', 'moderate', 'complex'],
  moderate: ['moderate', 'complex'],
  complex: ['complex'],
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
    for (const candidateLevel of ESCALATION_ORDER[level]) {
      const provider = this.config[candidateLevel];
      if (!this.isProviderAvailable(provider, role)) {
        continue;
      }
      return {
        provider,
        cli: resolveAgentCli(provider, role),
        role,
      };
    }
    throw new Error(`No configured provider available for ${role} at complexity level "${level}"`);
  }

  private assertKnownProvider(level: ComplexityLevel, provider: CanonicalProvider): void {
    if (!(provider in PROVIDER_CATALOG)) {
      throw new Error(`Routing config for ${level} references unknown provider "${provider}"`);
    }
  }

  private isProviderAvailable(provider: CanonicalProvider, role: DispatchRole): boolean {
    const providerConfig = PROVIDER_CATALOG[provider] as Partial<Record<DispatchRole, string>> | undefined;
    return typeof providerConfig?.[role] === 'string' && providerConfig[role]!.trim().length > 0;
  }
}

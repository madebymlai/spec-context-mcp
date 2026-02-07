import {
  PROVIDER_CATALOG,
  type CanonicalProvider,
  type DispatchRole,
  resolveDispatchProvider,
} from '../../config/discipline.js';
import type { ComplexityLevel, RoutingTableConfig, RoutingTableEntry } from './types.js';

const IMPLEMENTER_ENV_VAR = 'SPEC_CONTEXT_IMPLEMENTER';
const REVIEWER_ENV_VAR = 'SPEC_CONTEXT_REVIEWER';

function parseConfiguredProvider(value: string, envVarName: string): CanonicalProvider {
  const resolvedProvider = resolveDispatchProvider(value);
  if (!resolvedProvider) {
    throw new Error(`${envVarName} must reference a known provider; received "${value}"`);
  }
  return resolvedProvider;
}

function defaultProviderFromRoleEnv(envVarName: string): CanonicalProvider | null {
  const configuredValue = process.env[envVarName]?.trim();
  if (!configuredValue) {
    return null;
  }
  const provider = resolveDispatchProvider(configuredValue);
  if (!provider) {
    throw new Error(`${envVarName} must reference a known provider; received "${configuredValue}"`);
  }
  return provider;
}

export class RoutingTable {
  private readonly config: RoutingTableConfig;

  constructor(config: RoutingTableConfig) {
    this.assertKnownProvider('simple', config.simple);
    this.assertKnownProvider('complex', config.complex);
    this.config = config;
  }

  static fromEnvOrDefault(): RoutingTable {
    const simple = process.env.SPEC_CONTEXT_ROUTE_SIMPLE?.trim();
    const complex = process.env.SPEC_CONTEXT_ROUTE_COMPLEX?.trim();
    const explicitSimple = simple
      ? parseConfiguredProvider(simple, 'SPEC_CONTEXT_ROUTE_SIMPLE')
      : null;
    const explicitComplex = complex
      ? parseConfiguredProvider(complex, 'SPEC_CONTEXT_ROUTE_COMPLEX')
      : null;
    const inheritedSimple = defaultProviderFromRoleEnv(REVIEWER_ENV_VAR);
    const inheritedComplex = defaultProviderFromRoleEnv(IMPLEMENTER_ENV_VAR);

    if (!explicitSimple && !inheritedSimple) {
      throw new Error(
        'Routing for simple complexity is not configured; set SPEC_CONTEXT_ROUTE_SIMPLE or SPEC_CONTEXT_REVIEWER'
      );
    }
    if (!explicitComplex && !inheritedComplex) {
      throw new Error(
        'Routing for complex complexity is not configured; set SPEC_CONTEXT_ROUTE_COMPLEX or SPEC_CONTEXT_IMPLEMENTER'
      );
    }

    return new RoutingTable({
      simple: explicitSimple ?? inheritedSimple as CanonicalProvider,
      complex: explicitComplex ?? inheritedComplex as CanonicalProvider,
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

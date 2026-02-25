import {
  PROVIDER_CATALOG,
  type CanonicalProvider,
  type DispatchRole,
  resolveDispatchProvider,
} from '../../config/discipline.js';
import { resolveRuntimeSettings } from '../../config/runtime-settings.js';
import type { ComplexityLevel, IRoutingTable, RoutingTableConfig, RoutingTableEntry } from './types.js';

function resolveProvider(value: string | null, label: string): CanonicalProvider | null {
  if (!value || !value.trim()) {
    return null;
  }
  const provider = resolveDispatchProvider(value);
  if (!provider) {
    throw new Error(`${label} must reference a known provider; received "${value}"`);
  }
  return provider;
}

export class RoutingTable implements IRoutingTable {
  private readonly config: RoutingTableConfig;

  constructor(config: RoutingTableConfig) {
    this.assertKnownProvider('simple', config.simple);
    this.assertKnownProvider('complex', config.complex);
    this.config = config;
  }

  static async fromSettings(): Promise<RoutingTable> {
    const settings = await resolveRuntimeSettings();

    const simpleProvider = resolveProvider(settings.reviewer.value, 'reviewer');
    const complexProvider = resolveProvider(settings.implementer.value, 'implementer');

    if (!simpleProvider) {
      throw new Error(
        'Routing for simple complexity is not configured; set reviewer in dashboard settings'
      );
    }
    if (!complexProvider) {
      throw new Error(
        'Routing for complex complexity is not configured; set implementer in dashboard settings'
      );
    }

    return new RoutingTable({
      simple: simpleProvider,
      complex: complexProvider,
    });
  }

  resolve(level: ComplexityLevel, role: DispatchRole): RoutingTableEntry {
    return {
      provider: this.config[level],
      role,
    };
  }

  private assertKnownProvider(level: ComplexityLevel, provider: CanonicalProvider): void {
    if (!(provider in PROVIDER_CATALOG)) {
      throw new Error(`Routing config for ${level} references unknown provider "${provider}"`);
    }
  }
}

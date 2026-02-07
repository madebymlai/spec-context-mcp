import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveDashboardUrl } from '../dashboard-url.js';

const originalEnv = { ...process.env };

describe('resolveDashboardUrl', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  it('uses explicit DASHBOARD_URL override when provided', async () => {
    process.env.DASHBOARD_URL = 'http://localhost:4321';
    const mockGetDashboardSession = vi.fn().mockResolvedValue({ url: 'http://localhost:3000' });

    const result = await resolveDashboardUrl({
      sessionReader: {
        getDashboardSession: mockGetDashboardSession,
      },
    });

    expect(result).toBe('http://localhost:4321');
  });

  it('uses session URL when env is default', async () => {
    process.env.DASHBOARD_URL = 'http://localhost:3000';
    const mockGetDashboardSession = vi.fn().mockResolvedValue({ url: 'http://localhost:4567' });

    const result = await resolveDashboardUrl({
      sessionReader: {
        getDashboardSession: mockGetDashboardSession,
      },
    });

    expect(result).toBe('http://localhost:4567');
  });

  it('falls back to default when no env or session', async () => {
    delete process.env.DASHBOARD_URL;
    const mockGetDashboardSession = vi.fn().mockResolvedValue(null);

    const result = await resolveDashboardUrl({
      sessionReader: {
        getDashboardSession: mockGetDashboardSession,
      },
    });

    expect(result).toBe('http://localhost:3000');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetDashboardSession = vi.fn();

vi.mock('../dashboard-session.js', () => ({
  DashboardSessionManager: class {
    async getDashboardSession() {
      return mockGetDashboardSession();
    }
  }
}));

import { resolveDashboardUrl } from '../dashboard-url.js';

const originalEnv = { ...process.env };

describe('resolveDashboardUrl', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    mockGetDashboardSession.mockReset();
  });

  it('uses explicit DASHBOARD_URL override when provided', async () => {
    process.env.DASHBOARD_URL = 'http://localhost:4321';
    mockGetDashboardSession.mockResolvedValue({ url: 'http://localhost:3000' });

    const result = await resolveDashboardUrl();

    expect(result).toBe('http://localhost:4321');
  });

  it('uses session URL when env is default', async () => {
    process.env.DASHBOARD_URL = 'http://localhost:3000';
    mockGetDashboardSession.mockResolvedValue({ url: 'http://localhost:4567' });

    const result = await resolveDashboardUrl();

    expect(result).toBe('http://localhost:4567');
  });

  it('falls back to default when no env or session', async () => {
    delete process.env.DASHBOARD_URL;
    mockGetDashboardSession.mockResolvedValue(null);

    const result = await resolveDashboardUrl();

    expect(result).toBe('http://localhost:3000');
  });
});

export function isDispatchRuntimeV2Enabled(): boolean {
  const value = (process.env.SPEC_CONTEXT_DISPATCH_RUNTIME_V2 || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

import { normalizeApiPrefix } from './app.config';

describe('normalizeApiPrefix', () => {
  it('defaults to api when undefined', () => {
    expect(normalizeApiPrefix(undefined)).toBe('api');
  });

  it('allows an empty string for subdomain-based deployments', () => {
    expect(normalizeApiPrefix('')).toBe('');
    expect(normalizeApiPrefix('   ')).toBe('');
  });

  it('removes surrounding slashes and spaces', () => {
    expect(normalizeApiPrefix(' /api/v1/ ')).toBe('api/v1');
  });
});

/**
 * Logger Redactor Tests
 *
 * Tests for credential sanitization to ensure sensitive data
 * is never logged (NFR12 compliance).
 */

import { describe, it, expect } from 'vitest';
import { redactSensitive } from '../redactor.js';

describe('Redactor Module (AC4)', () => {
  describe('Sensitive field detection', () => {
    it('redacts fields containing "key"', () => {
      const result = redactSensitive({
        apiKey: 'secret123',
        api_key: 'secret456',
        myKey: 'secret789',
      });

      expect(result.apiKey).toBe('[REDACTED]');
      expect(result.api_key).toBe('[REDACTED]');
      expect(result.myKey).toBe('[REDACTED]');
    });

    it('redacts fields containing "secret"', () => {
      const result = redactSensitive({
        apiSecret: 'hidden',
        client_secret: 'hidden2',
        secretValue: 'hidden3',
      });

      expect(result.apiSecret).toBe('[REDACTED]');
      expect(result.client_secret).toBe('[REDACTED]');
      expect(result.secretValue).toBe('[REDACTED]');
    });

    it('redacts fields containing "password"', () => {
      const result = redactSensitive({
        password: 'mypass',
        userPassword: 'pass123',
        password_hash: 'hash',
      });

      expect(result.password).toBe('[REDACTED]');
      expect(result.userPassword).toBe('[REDACTED]');
      expect(result.password_hash).toBe('[REDACTED]');
    });

    it('redacts fields containing "token"', () => {
      const result = redactSensitive({
        token: 'jwt...',
        accessToken: 'abc',
        refresh_token: 'xyz',
      });

      expect(result.token).toBe('[REDACTED]');
      expect(result.accessToken).toBe('[REDACTED]');
      expect(result.refresh_token).toBe('[REDACTED]');
    });

    it('redacts fields containing "credential"', () => {
      const result = redactSensitive({
        credentials: { user: 'x' },
        credential: 'value',
        userCredential: 'cred',
      });

      expect(result.credentials).toBe('[REDACTED]');
      expect(result.credential).toBe('[REDACTED]');
      expect(result.userCredential).toBe('[REDACTED]');
    });

    it('redacts fields containing "auth"', () => {
      const result = redactSensitive({
        auth: 'bearer xyz',
        authorization: 'Bearer token',
        authHeader: 'value',
      });

      expect(result.auth).toBe('[REDACTED]');
      expect(result.authorization).toBe('[REDACTED]');
      expect(result.authHeader).toBe('[REDACTED]');
    });

    it('redacts fields containing "private"', () => {
      const result = redactSensitive({
        privateKey: '-----BEGIN PRIVATE KEY-----',
        private_data: 'sensitive',
      });

      expect(result.privateKey).toBe('[REDACTED]');
      expect(result.private_data).toBe('[REDACTED]');
    });

    it('redacts api_key pattern variations', () => {
      const result = redactSensitive({
        apiKey: 'x',
        api_key: 'y',
        ApiKey: 'z',
      });

      expect(result.apiKey).toBe('[REDACTED]');
      expect(result.api_key).toBe('[REDACTED]');
      expect(result.ApiKey).toBe('[REDACTED]');
    });
  });

  describe('Nested object handling', () => {
    it('redacts nested sensitive fields', () => {
      const result = redactSensitive({
        config: {
          api: {
            apiKey: 'nested-secret',
            endpoint: 'https://api.example.com',
          },
        },
      });

      expect(result.config.api.apiKey).toBe('[REDACTED]');
      expect(result.config.api.endpoint).toBe('https://api.example.com');
    });

    it('handles deeply nested objects', () => {
      const result = redactSensitive({
        level1: {
          level2: {
            level3: {
              level4: {
                secretKey: 'deep-secret',
                normalField: 'visible',
              },
            },
          },
        },
      });

      expect(result.level1.level2.level3.level4.secretKey).toBe('[REDACTED]');
      expect(result.level1.level2.level3.level4.normalField).toBe('visible');
    });
  });

  describe('Array handling', () => {
    it('handles arrays with sensitive data', () => {
      const result = redactSensitive({
        items: [
          { name: 'item1', apiKey: 'key1' },
          { name: 'item2', apiKey: 'key2' },
        ],
      });

      expect(result.items[0].name).toBe('item1');
      expect(result.items[0].apiKey).toBe('[REDACTED]');
      expect(result.items[1].name).toBe('item2');
      expect(result.items[1].apiKey).toBe('[REDACTED]');
    });

    it('handles arrays of primitives', () => {
      const result = redactSensitive({
        ids: [1, 2, 3],
        names: ['a', 'b', 'c'],
      });

      expect(result.ids).toEqual([1, 2, 3]);
      expect(result.names).toEqual(['a', 'b', 'c']);
    });

    it('handles nested arrays', () => {
      const result = redactSensitive({
        matrix: [
          [{ password: 'p1' }, { value: 1 }],
          [{ password: 'p2' }, { value: 2 }],
        ],
      });

      expect(result.matrix[0][0].password).toBe('[REDACTED]');
      expect(result.matrix[0][1].value).toBe(1);
      expect(result.matrix[1][0].password).toBe('[REDACTED]');
    });
  });

  describe('Edge cases', () => {
    it('returns null for null input', () => {
      expect(redactSensitive(null)).toBe(null);
    });

    it('returns undefined for undefined input', () => {
      expect(redactSensitive(undefined)).toBe(undefined);
    });

    it('returns primitives unchanged', () => {
      expect(redactSensitive('string')).toBe('string');
      expect(redactSensitive(123)).toBe(123);
      expect(redactSensitive(true)).toBe(true);
    });

    it('handles empty objects', () => {
      expect(redactSensitive({})).toEqual({});
    });

    it('handles empty arrays', () => {
      expect(redactSensitive([])).toEqual([]);
    });

    it('preserves non-sensitive fields', () => {
      const result = redactSensitive({
        user_id: 'u123',
        email: 'test@example.com',
        count: 42,
        enabled: true,
      });

      expect(result.user_id).toBe('u123');
      expect(result.email).toBe('test@example.com');
      expect(result.count).toBe(42);
      expect(result.enabled).toBe(true);
    });

    it('handles circular references', () => {
      const obj = { name: 'test' };
      obj.self = obj;

      const result = redactSensitive(obj);

      expect(result.name).toBe('test');
      expect(result.self).toBe('[Circular]');
    });

    it('handles mixed sensitive and non-sensitive', () => {
      const result = redactSensitive({
        username: 'john',
        password: 'secret',
        settings: {
          theme: 'dark',
          apiToken: 'xyz',
        },
      });

      expect(result.username).toBe('john');
      expect(result.password).toBe('[REDACTED]');
      expect(result.settings.theme).toBe('dark');
      expect(result.settings.apiToken).toBe('[REDACTED]');
    });
  });

  describe('Case insensitivity', () => {
    it('matches patterns case-insensitively', () => {
      const result = redactSensitive({
        PASSWORD: 'upper',
        Password: 'mixed',
        pAsSwOrD: 'weird',
      });

      expect(result.PASSWORD).toBe('[REDACTED]');
      expect(result.Password).toBe('[REDACTED]');
      expect(result.pAsSwOrD).toBe('[REDACTED]');
    });
  });
});

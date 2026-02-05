/**
 * Pre-flight Checks Tests
 *
 * Tests the actual check functions from preflight.mjs.
 * Uses mocks for external dependencies (database, CLI, API).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Store original process.env
const originalEnv = { ...process.env };

// ================================
// MOCK SETUP
// ================================
const mockExecSync = vi.fn();
const mockExistsSync = vi.fn(() => true);
const mockReaddirSync = vi.fn(() => [
  '001-initial-schema.js',
  '002-add-positions-table.js',
  '003-daily-performance-table.js',
]);

// PostgreSQL mock
const mockPgQuery = vi.fn();
const mockPgConnect = vi.fn().mockResolvedValue(undefined);
const mockPgEnd = vi.fn().mockResolvedValue(undefined);

class MockPgClient {
  constructor() {}
  connect() { return mockPgConnect(); }
  query(...args) { return mockPgQuery(...args); }
  end() { return mockPgEnd(); }
}

const mockLaunchInit = vi.fn(async () => {});
const mockLaunchShutdown = vi.fn(async () => {});
const mockLoadManifest = vi.fn(() => ({
  strategies: ['simple-threshold', 'oracle-edge'],
  position_size_dollars: 10,
  max_exposure_dollars: 500,
  symbols: ['BTC', 'ETH'],
  kill_switch_enabled: true,
}));
const mockIsKnownStrategy = vi.fn((name) => ['simple-threshold', 'oracle-edge'].includes(name));

const mockGetBalanceAllowance = vi.fn().mockResolvedValue({ amount: '1000000000' });
class MockClobClientClass {
  getBalanceAllowance(...args) { return mockGetBalanceAllowance(...args); }
}

class MockWalletClass {
  constructor() {
    this.address = '0x1234567890123456789012345678901234567890';
  }
}

// Mock modules BEFORE importing the script
vi.mock('child_process', () => ({
  execSync: mockExecSync,
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    existsSync: mockExistsSync,
    readdirSync: mockReaddirSync,
  };
});

vi.mock('pg', () => ({
  default: { Client: MockPgClient },
  Client: MockPgClient,
}));

// Mock config
vi.mock('../../config/index.js', () => ({
  default: {
    tradingMode: 'PAPER',
    database: { url: 'postgresql://test:test@localhost:5432/poly' },
    polymarket: {
      apiUrl: 'https://clob.polymarket.com',
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      passphrase: 'test-pass',
      privateKey: '0x1234567890123456789012345678901234567890123456789012345678901234',
    },
  },
}));

// Mock launch-config module
vi.mock('../../src/modules/launch-config/index.js', () => ({
  init: mockLaunchInit,
  shutdown: mockLaunchShutdown,
  loadManifest: mockLoadManifest,
  isKnownStrategy: mockIsKnownStrategy,
}));

// Mock @polymarket/clob-client
vi.mock('@polymarket/clob-client', () => ({
  ClobClient: MockClobClientClass,
}));

// Mock ethers
vi.mock('ethers', () => ({
  Wallet: MockWalletClass,
}));

// Mock dotenv
vi.mock('dotenv', () => ({
  config: vi.fn(),
}));

// Import the actual functions from preflight.mjs AFTER mocking
const {
  checkEnvironment,
  checkDatabaseConnection,
  checkMigrations,
  checkRailwayCli,
  checkLaunchManifest,
  checkPolymarketAuth,
  sanitizeErrorMessage,
} = await import('../preflight.mjs');

describe('Pre-flight Checks - Actual Implementation Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Restore original env and set test values
    process.env = { ...originalEnv };
    process.env.POLYMARKET_API_KEY = 'test-key';
    process.env.POLYMARKET_API_SECRET = 'test-secret';
    process.env.POLYMARKET_PASSPHRASE = 'test-pass';
    process.env.POLYMARKET_PRIVATE_KEY = '0x1234';
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/poly';

    // Reset mock implementations
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      '001-initial-schema.js',
      '002-add-positions-table.js',
      '003-daily-performance-table.js',
    ]);
    mockLoadManifest.mockReturnValue({
      strategies: ['simple-threshold', 'oracle-edge'],
      position_size_dollars: 10,
      max_exposure_dollars: 500,
      symbols: ['BTC', 'ETH'],
      kill_switch_enabled: true,
    });
    mockGetBalanceAllowance.mockResolvedValue({ amount: '1000000000' });
    mockPgConnect.mockResolvedValue(undefined);
    mockPgEnd.mockResolvedValue(undefined);
    mockPgQuery.mockResolvedValue({ rows: [{ ok: 1 }] });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('checkEnvironment()', () => {
    it('should pass when all required env vars are set', () => {
      const result = checkEnvironment();
      expect(result.pass).toBe(true);
      expect(result.name).toBe('Environment Variables');
      expect(result.details).toContain('All required vars set');
      expect(result.error).toBeNull();
    });

    it('should fail when env vars are missing', () => {
      delete process.env.POLYMARKET_API_KEY;
      delete process.env.POLYMARKET_API_SECRET;

      const result = checkEnvironment();
      expect(result.pass).toBe(false);
      expect(result.error).toContain('POLYMARKET_API_KEY');
      expect(result.error).toContain('POLYMARKET_API_SECRET');
    });

    it('should fail when env vars are empty strings', () => {
      process.env.POLYMARKET_API_KEY = '';
      process.env.POLYMARKET_API_SECRET = '   ';

      const result = checkEnvironment();
      expect(result.pass).toBe(false);
      expect(result.error).toContain('POLYMARKET_API_KEY');
      expect(result.error).toContain('POLYMARKET_API_SECRET');
    });

    it('should fail when DATABASE_URL is missing', () => {
      delete process.env.DATABASE_URL;

      const result = checkEnvironment();
      expect(result.pass).toBe(false);
      expect(result.error).toContain('DATABASE_URL');
    });
  });

  describe('checkDatabaseConnection()', () => {
    it('should pass when PostgreSQL is accessible', async () => {
      mockPgQuery.mockResolvedValue({ rows: [{ ok: 1 }] });

      const result = await checkDatabaseConnection();
      expect(result.pass).toBe(true);
      expect(result.name).toBe('Database');
      expect(result.details).toBe('PostgreSQL connected');
    });

    it('should fail when connection fails', async () => {
      mockPgConnect.mockRejectedValue(new Error('Connection refused'));

      const result = await checkDatabaseConnection();
      expect(result.pass).toBe(false);
      expect(result.error).toContain('Connection failed');
    });
  });

  describe('checkMigrations()', () => {
    it('should pass when all migrations are applied', async () => {
      mockPgQuery.mockResolvedValue({
        rows: [{ version: '001' }, { version: '002' }, { version: '003' }],
      });

      const result = await checkMigrations();
      expect(result.pass).toBe(true);
      expect(result.details).toBe('3/3 applied');
    });

    it('should fail when migrations are missing', async () => {
      mockPgQuery.mockResolvedValue({
        rows: [{ version: '001' }, { version: '002' }],
      });

      const result = await checkMigrations();
      expect(result.pass).toBe(false);
      expect(result.details).toBe('2/3 applied');
      expect(result.error).toContain('Missing 1 migration');
    });

    it('should fail when extra migrations in DB', async () => {
      mockReaddirSync.mockReturnValue([
        '001-initial-schema.js',
        '002-add-positions-table.js',
      ]);
      mockPgQuery.mockResolvedValue({
        rows: [{ version: '001' }, { version: '002' }, { version: '003' }],
      });

      const result = await checkMigrations();
      expect(result.pass).toBe(false);
      expect(result.details).toBe('3/2 applied');
      expect(result.error).toContain('Extra 1 migration');
    });

    it('should exclude index.js from migration count', async () => {
      mockReaddirSync.mockReturnValue([
        '001-initial-schema.js',
        '002-add-positions-table.js',
        'index.js',
      ]);
      mockPgQuery.mockResolvedValue({
        rows: [{ version: '001' }, { version: '002' }],
      });

      const result = await checkMigrations();
      expect(result.pass).toBe(true);
      expect(result.details).toBe('2/2 applied');
    });

    it('should fail when schema_migrations table does not exist', async () => {
      mockPgQuery.mockRejectedValue(new Error('relation "schema_migrations" does not exist'));

      const result = await checkMigrations();
      expect(result.pass).toBe(false);
      expect(result.error).toContain('schema_migrations table not found');
    });
  });

  describe('checkRailwayCli()', () => {
    it('should pass when CLI is installed and authenticated', () => {
      mockExecSync.mockReturnValueOnce('railway 4.27.0\n');
      mockExecSync.mockReturnValueOnce('Project: my-project\nEnvironment: production\n');

      const result = checkRailwayCli();
      expect(result.pass).toBe(true);
      expect(result.details).toContain('authenticated');
      expect(result.details).toContain('my-project');
    });

    it('should use timeout for CLI commands', () => {
      mockExecSync.mockReturnValueOnce('railway 4.27.0\n');
      mockExecSync.mockReturnValueOnce('Project: test\n');

      checkRailwayCli();

      expect(mockExecSync).toHaveBeenCalledWith(
        'railway --version',
        expect.objectContaining({ timeout: 15000 })
      );
      expect(mockExecSync).toHaveBeenCalledWith(
        'railway status',
        expect.objectContaining({ timeout: 15000 })
      );
    });

    it('should fail when CLI is not installed', () => {
      mockExecSync.mockImplementationOnce(() => {
        const err = new Error('command not found: railway');
        err.code = 'ENOENT';
        throw err;
      });

      const result = checkRailwayCli();
      expect(result.pass).toBe(false);
      expect(result.error).toContain('not installed');
    });

    it('should fail when not authenticated', () => {
      mockExecSync.mockReturnValueOnce('railway 4.27.0\n');
      mockExecSync.mockImplementationOnce(() => {
        const err = new Error('');
        err.stderr = Buffer.from('error: not logged in');
        throw err;
      });

      const result = checkRailwayCli();
      expect(result.pass).toBe(false);
      expect(result.error).toContain('Not authenticated');
    });

    it('should fail with timeout error message', () => {
      mockExecSync.mockImplementationOnce(() => {
        const err = new Error('ETIMEDOUT');
        throw err;
      });

      const result = checkRailwayCli();
      expect(result.pass).toBe(false);
      expect(result.error).toContain('timed out');
    });

    it('should provide meaningful error when message and stderr are empty', () => {
      mockExecSync.mockReturnValueOnce('railway 4.27.0\n');
      mockExecSync.mockImplementationOnce(() => {
        const err = new Error('');
        err.stderr = Buffer.from('');
        throw err;
      });

      const result = checkRailwayCli();
      expect(result.pass).toBe(false);
      expect(result.error).toContain('Unknown CLI error');
    });

    it('should pass with warning when project name cannot be parsed', () => {
      mockExecSync.mockReturnValueOnce('railway 4.27.0\n');
      mockExecSync.mockReturnValueOnce('Some unexpected format\nNo project info\n');

      const result = checkRailwayCli();
      expect(result.pass).toBe(true);
      expect(result.details).toContain('could not be parsed');
    });
  });

  describe('checkLaunchManifest()', () => {
    it('should pass when manifest is valid', async () => {
      const result = await checkLaunchManifest();
      expect(result.pass).toBe(true);
      expect(result.name).toBe('Launch Manifest');
      expect(result.details).toContain('2 strategies');
    });

    it('should fail when strategy is unknown', async () => {
      mockLoadManifest.mockReturnValueOnce({
        strategies: ['simple-threshold', 'unknown-strategy'],
        position_size_dollars: 10,
        max_exposure_dollars: 500,
      });

      const result = await checkLaunchManifest();
      expect(result.pass).toBe(false);
      expect(result.error).toContain('Unknown strategies');
    });

    it('should fail when position_size_dollars is zero', async () => {
      mockLoadManifest.mockReturnValueOnce({
        strategies: ['simple-threshold'],
        position_size_dollars: 0,
        max_exposure_dollars: 500,
      });

      const result = await checkLaunchManifest();
      expect(result.pass).toBe(false);
      expect(result.error).toContain('position_size_dollars must be > 0');
    });

    it('should fail when max_exposure <= position_size', async () => {
      mockLoadManifest.mockReturnValueOnce({
        strategies: ['simple-threshold'],
        position_size_dollars: 100,
        max_exposure_dollars: 50,
      });

      const result = await checkLaunchManifest();
      expect(result.pass).toBe(false);
      expect(result.error).toContain('max_exposure_dollars must be > position_size_dollars');
    });

    it('should handle init errors gracefully', async () => {
      mockLaunchInit.mockRejectedValueOnce(new Error('Config file not found'));

      const result = await checkLaunchManifest();
      expect(result.pass).toBe(false);
      expect(result.error).toContain('Module init failed');
    });
  });

  describe('checkPolymarketAuth()', () => {
    it('should pass when API auth succeeds', async () => {
      mockGetBalanceAllowance.mockResolvedValue({ amount: '1000000000' });

      const result = await checkPolymarketAuth();
      expect(result.pass).toBe(true);
      expect(result.details).toContain('connected');
      expect(result.details).toContain('balance');
    });

    it('should fail when balance is invalid', async () => {
      mockGetBalanceAllowance.mockResolvedValue({ amount: 'invalid' });

      const result = await checkPolymarketAuth();
      expect(result.pass).toBe(false);
      expect(result.error).toContain('Invalid balance response');
    });

    it('should sanitize error messages on API failure', async () => {
      mockGetBalanceAllowance.mockRejectedValue(new Error('Invalid key: 0x1234567890123456789012345678901234567890'));

      const result = await checkPolymarketAuth();
      expect(result.pass).toBe(false);
      expect(result.error).toContain('[REDACTED]');
      expect(result.error).not.toContain('0x1234567890123456789012345678901234567890');
    });
  });

  describe('sanitizeErrorMessage()', () => {
    it('should redact Ethereum addresses', () => {
      const message = 'Invalid key: 0x1234567890123456789012345678901234567890';
      const sanitized = sanitizeErrorMessage(message);
      expect(sanitized).toContain('[REDACTED]');
      expect(sanitized).not.toContain('0x1234');
    });

    it('should redact 64-char hex strings (private keys)', () => {
      const message = 'Bad key: abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
      const sanitized = sanitizeErrorMessage(message);
      expect(sanitized).toContain('[REDACTED]');
    });

    it('should redact key=value patterns', () => {
      const message = 'Error with key=mysecretkey123';
      const sanitized = sanitizeErrorMessage(message);
      expect(sanitized).toContain('[REDACTED]');
      expect(sanitized).not.toContain('mysecretkey123');
    });

    it('should return Unknown error for empty/null input', () => {
      expect(sanitizeErrorMessage(null)).toBe('Unknown error');
      expect(sanitizeErrorMessage('')).toBe('Unknown error');
      expect(sanitizeErrorMessage(undefined)).toBe('Unknown error');
    });
  });

  describe('CheckResult interface consistency', () => {
    it('should have consistent structure for passing result', () => {
      const result = checkEnvironment();
      expect(result).toHaveProperty('name');
      expect(result).toHaveProperty('pass');
      expect(result).toHaveProperty('details');
      expect(result).toHaveProperty('error');
    });

    it('should have consistent structure for failing result', () => {
      delete process.env.POLYMARKET_API_KEY;

      const result = checkEnvironment();
      expect(result.pass).toBe(false);
      expect(result.error).toBeTruthy();
    });
  });
});

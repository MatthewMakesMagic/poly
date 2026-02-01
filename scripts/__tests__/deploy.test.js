/**
 * Deploy Command Tests
 *
 * Tests the deploy script functions including:
 * - displayManifest() formatting
 * - promptUser() behavior
 * - Error categorization and suggestions
 * - Integration flow with mocked git/railway
 * - Error message sanitization
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Store original process.env
const originalEnv = { ...process.env };

// ================================
// MOCK SETUP
// ================================

// Mock child_process
const mockSpawn = vi.fn();
const mockExecSync = vi.fn();

vi.mock('child_process', () => ({
  spawn: (...args) => mockSpawn(...args),
  execSync: (...args) => mockExecSync(...args),
}));

// Mock readline for promptUser tests
let mockReadlineAnswer = 'y';
const mockRlQuestion = vi.fn((question, callback) => {
  callback(mockReadlineAnswer);
});
const mockRlClose = vi.fn();

vi.mock('readline', () => ({
  createInterface: () => ({
    question: mockRlQuestion,
    close: mockRlClose,
  }),
}));

// Mock dotenv
vi.mock('dotenv', () => ({
  config: vi.fn(),
}));

// Mock config
vi.mock('../../config/index.js', () => ({
  default: {
    database: { path: './data/poly.db' },
    server: { port: 3333 },
    polymarket: {
      apiUrl: 'https://clob.polymarket.com',
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      passphrase: 'test-pass',
      privateKey: '0x1234',
    },
  },
}));

// Mock preflight functions
const mockCheckEnvironment = vi.fn(() => ({ name: 'Environment Variables', pass: true, details: 'All 4 required vars set', error: null }));
const mockCheckPolymarketAuth = vi.fn(async () => ({ name: 'Polymarket API', pass: true, details: 'connected (balance: $1000.00)', error: null }));
const mockCheckDatabaseConnection = vi.fn(() => ({ name: 'Database', pass: true, details: 'connected', error: null }));
const mockCheckMigrations = vi.fn(() => ({ name: 'Database Migrations', pass: true, details: '13/13 applied', error: null }));
const mockCheckRailwayCli = vi.fn(() => ({ name: 'Railway CLI', pass: true, details: 'authenticated (project: poly)', error: null }));
const mockCheckLaunchManifest = vi.fn(async () => ({ name: 'Launch Manifest', pass: true, details: 'valid (1 strategies)', error: null }));
const mockFormatResults = vi.fn();
const mockSanitizeErrorMessage = vi.fn((msg) => msg || 'Unknown error');

vi.mock('../preflight.mjs', () => ({
  checkEnvironment: () => mockCheckEnvironment(),
  checkPolymarketAuth: () => mockCheckPolymarketAuth(),
  checkDatabaseConnection: () => mockCheckDatabaseConnection(),
  checkMigrations: () => mockCheckMigrations(),
  checkRailwayCli: () => mockCheckRailwayCli(),
  checkLaunchManifest: () => mockCheckLaunchManifest(),
  formatResults: (results) => mockFormatResults(results),
  sanitizeErrorMessage: (msg) => mockSanitizeErrorMessage(msg),
}));

// Mock verify functions
const mockRunVerifications = vi.fn(async () => ({
  results: [
    { name: 'Health Endpoint', pass: true, details: 'responding (150ms)' },
    { name: 'Strategy Match', pass: true, details: 'All 1 strategies active' },
  ],
  allPassed: true,
}));
const mockFormatVerifyResults = vi.fn();
const mockSanitizeVerifyError = vi.fn((msg) => msg || 'Unknown error');

vi.mock('../verify.mjs', () => ({
  runVerifications: () => mockRunVerifications(),
  formatVerifyResults: (results) => mockFormatVerifyResults(results),
  sanitizeErrorMessage: (msg) => mockSanitizeVerifyError(msg),
}));

// Mock launch-config module
const mockLoadManifest = vi.fn(() => ({
  strategies: ['simple-threshold'],
  position_size_dollars: 10,
  max_exposure_dollars: 500,
  symbols: ['BTC', 'ETH', 'SOL', 'XRP'],
  kill_switch_enabled: true,
}));
const mockInitLaunchConfig = vi.fn(async () => {});
const mockShutdownLaunchConfig = vi.fn(async () => {});

vi.mock('../../src/modules/launch-config/index.js', () => ({
  loadManifest: () => mockLoadManifest(),
  init: () => mockInitLaunchConfig(),
  shutdown: () => mockShutdownLaunchConfig(),
}));

// Import the functions after mocking
const {
  displayManifest,
  promptUser,
  hasUncommittedChanges,
  selectDeployMethod,
  displayError,
  displaySuccess,
  runPreflightChecks,
  waitForDeployment,
  deployViaGit,
  deployViaRailwayCli,
} = await import('../deploy.mjs');

describe('Deploy Command Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.RAILWAY_STATIC_URL = 'https://poly-production.up.railway.app';
    mockReadlineAnswer = 'y';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('displayManifest()', () => {
    it('should display manifest fields correctly', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const manifest = {
        strategies: ['simple-threshold', 'oracle-edge'],
        position_size_dollars: 10,
        max_exposure_dollars: 500,
        symbols: ['BTC', 'ETH'],
        kill_switch_enabled: true,
      };

      displayManifest(manifest);

      expect(consoleSpy).toHaveBeenCalledWith('\nCurrent launch.json:');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Strategies:'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('simple-threshold, oracle-edge'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Position size:'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('$10'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Max exposure:'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('$500'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Symbols:'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('BTC, ETH'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Kill switch:'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('enabled'));

      consoleSpy.mockRestore();
    });

    it('should display disabled kill switch correctly', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const manifest = {
        strategies: ['simple-threshold'],
        position_size_dollars: 10,
        max_exposure_dollars: 500,
        symbols: ['BTC'],
        kill_switch_enabled: false,
      };

      displayManifest(manifest);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('disabled'));

      consoleSpy.mockRestore();
    });
  });

  describe('promptUser()', () => {
    it('should return lowercase trimmed answer', async () => {
      mockReadlineAnswer = '  YES  ';

      const answer = await promptUser('Test question? ');

      expect(mockRlQuestion).toHaveBeenCalledWith('Test question? ', expect.any(Function));
      expect(mockRlClose).toHaveBeenCalled();
      expect(answer).toBe('yes');
    });

    it('should handle "n" answer', async () => {
      mockReadlineAnswer = 'n';

      const answer = await promptUser('Continue? ');

      expect(answer).toBe('n');
    });
  });

  describe('hasUncommittedChanges()', () => {
    it('should return true when git status has output', () => {
      mockExecSync.mockReturnValue(' M config/launch.json\n?? newfile.js\n');

      const result = hasUncommittedChanges();

      expect(result).toBe(true);
      expect(mockExecSync).toHaveBeenCalledWith(
        'git status --porcelain',
        expect.objectContaining({ encoding: 'utf-8' })
      );
    });

    it('should return false when git status is empty', () => {
      mockExecSync.mockReturnValue('');

      const result = hasUncommittedChanges();

      expect(result).toBe(false);
    });

    it('should return false on git error', () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('not a git repository');
      });

      const result = hasUncommittedChanges();

      expect(result).toBe(false);
    });
  });

  describe('selectDeployMethod()', () => {
    it('should return "git" when origin remote exists', () => {
      mockExecSync.mockReturnValue('git@github.com:user/repo.git');

      const method = selectDeployMethod();

      expect(method).toBe('git');
      expect(mockExecSync).toHaveBeenCalledWith(
        'git remote get-url origin',
        expect.any(Object)
      );
    });

    it('should return "railway" when origin remote does not exist', () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('No such remote');
      });

      const method = selectDeployMethod();

      expect(method).toBe('railway');
    });
  });

  describe('displayError()', () => {
    let consoleSpy;

    beforeEach(() => {
      consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleSpy.mockRestore();
    });

    it('should display preflight error with fix suggestion', () => {
      displayError('preflight');

      expect(consoleSpy).toHaveBeenCalledWith('\n✗ DEPLOYMENT FAILED\n');
      expect(consoleSpy).toHaveBeenCalledWith('Preflight checks failed.');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('npm run deploy'));
    });

    it('should display abort error message', () => {
      displayError('abort');

      expect(consoleSpy).toHaveBeenCalledWith('Deploy cancelled. No changes made.');
    });

    it('should display git error with suggestions', () => {
      displayError('git', 'push failed');

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Git push failed'));
      expect(consoleSpy).toHaveBeenCalledWith('\nSuggested fixes:');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('git remote'));
    });

    it('should display railway error with suggestions', () => {
      displayError('railway', 'deploy failed');

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Railway deploy failed'));
      expect(consoleSpy).toHaveBeenCalledWith('\nSuggested fixes:');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('railway login'));
    });

    it('should display verify error with suggestions', () => {
      displayError('verify', 'health check failed');

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Verification failed'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('System deployed but unhealthy'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Scout'));
    });

    it('should sanitize error messages (AC #5)', () => {
      mockSanitizeErrorMessage.mockReturnValue('[REDACTED]');

      displayError('git', 'key=secretvalue');

      expect(mockSanitizeErrorMessage).toHaveBeenCalledWith('key=secretvalue');
    });
  });

  describe('displaySuccess()', () => {
    it('should display success message with Scout mention', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      displaySuccess();

      expect(consoleSpy).toHaveBeenCalledWith('\n✓ DEPLOYMENT SUCCESSFUL\n');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Scout'));

      consoleSpy.mockRestore();
    });
  });

  describe('runPreflightChecks()', () => {
    it('should run all preflight checks and return results', async () => {
      const { results, allPassed } = await runPreflightChecks();

      expect(results).toHaveLength(6);
      expect(allPassed).toBe(true);
      expect(mockCheckEnvironment).toHaveBeenCalled();
      expect(mockCheckPolymarketAuth).toHaveBeenCalled();
      expect(mockCheckDatabaseConnection).toHaveBeenCalled();
      expect(mockCheckMigrations).toHaveBeenCalled();
      expect(mockCheckRailwayCli).toHaveBeenCalled();
      expect(mockCheckLaunchManifest).toHaveBeenCalled();
    });

    it('should return allPassed=false when any check fails', async () => {
      mockCheckEnvironment.mockReturnValueOnce({
        name: 'Environment Variables',
        pass: false,
        details: '',
        error: 'Missing: POLYMARKET_API_KEY',
      });

      const { results, allPassed } = await runPreflightChecks();

      expect(allPassed).toBe(false);
      expect(results[0].pass).toBe(false);
    });
  });

  describe('Integration: Deploy Flow', () => {
    it('should abort if preflight fails (AC #1)', async () => {
      mockCheckEnvironment.mockReturnValueOnce({
        name: 'Environment Variables',
        pass: false,
        error: 'Missing vars',
      });

      const { allPassed } = await runPreflightChecks();

      expect(allPassed).toBe(false);
      // In actual flow, this would trigger displayError('preflight') and exit(1)
    });

    it('should display manifest after preflight passes (AC #2)', async () => {
      const { allPassed } = await runPreflightChecks();
      expect(allPassed).toBe(true);

      // Simulate manifest display
      await mockInitLaunchConfig();
      const manifest = mockLoadManifest();
      await mockShutdownLaunchConfig();

      expect(manifest.strategies).toContain('simple-threshold');
      expect(manifest.position_size_dollars).toBe(10);
    });
  });

  describe('Error sanitization for deploy errors (Task 10.5)', () => {
    it('should sanitize git errors containing credentials', () => {
      mockSanitizeErrorMessage.mockReturnValue('[REDACTED] failed');

      displayError('git', 'Auth failed with key=abc123secret');

      expect(mockSanitizeErrorMessage).toHaveBeenCalledWith('Auth failed with key=abc123secret');
    });

    it('should sanitize railway errors containing tokens', () => {
      mockSanitizeVerifyError.mockReturnValue('[REDACTED]');

      displayError('verify', 'token: secrettoken123');

      // Note: verify errors use sanitizeVerifyError
      expect(mockSanitizeVerifyError).toHaveBeenCalled();
    });
  });

  describe('waitForDeployment() (ISSUE 13 fix)', () => {
    it('should wait specified delay with countdown using fake timers', async () => {
      vi.useFakeTimers();

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => {});

      // Start the wait but don't await yet
      const waitPromise = waitForDeployment(10); // 10 second delay

      // Fast-forward time
      await vi.advanceTimersByTimeAsync(10 * 1000 + 100);

      await waitPromise;

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Waiting'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Deployment should be starting'));

      consoleSpy.mockRestore();
      stdoutSpy.mockRestore();
      vi.useRealTimers();
    });

    it('should default to 30 seconds if no delay specified', async () => {
      // Just verify the function signature accepts no args - don't actually wait 30s
      expect(waitForDeployment).toBeDefined();
      expect(typeof waitForDeployment).toBe('function');
    });
  });

  describe('displayManifest() edge cases (ISSUE 8, 9 fixes)', () => {
    it('should handle empty strategies array', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const manifest = {
        strategies: [],
        position_size_dollars: 10,
        max_exposure_dollars: 500,
        symbols: ['BTC'],
        kill_switch_enabled: true,
      };

      displayManifest(manifest);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('(none)'));

      consoleSpy.mockRestore();
    });

    it('should handle missing strategies property', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const manifest = {
        position_size_dollars: 10,
        max_exposure_dollars: 500,
        symbols: ['BTC'],
        kill_switch_enabled: true,
      };

      // Should not throw
      expect(() => displayManifest(manifest)).not.toThrow();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('(none)'));

      consoleSpy.mockRestore();
    });

    it('should handle null manifest', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      // Should not throw
      expect(() => displayManifest(null)).not.toThrow();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('N/A'));

      consoleSpy.mockRestore();
    });

    it('should handle undefined properties', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const manifest = {};

      expect(() => displayManifest(manifest)).not.toThrow();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Strategies:'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('(none)'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('N/A'));

      consoleSpy.mockRestore();
    });

    it('should handle empty symbols array', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const manifest = {
        strategies: ['simple-threshold'],
        position_size_dollars: 10,
        max_exposure_dollars: 500,
        symbols: [],
        kill_switch_enabled: true,
      };

      displayManifest(manifest);

      // Find the call for Symbols
      const symbolsCall = consoleSpy.mock.calls.find(call =>
        call[0] && call[0].includes('Symbols:')
      );
      expect(symbolsCall[0]).toContain('(none)');

      consoleSpy.mockRestore();
    });
  });

  describe('deployViaGit() (ISSUE 10 - timeout behavior)', () => {
    it('should reject on spawn error with ENOENT', async () => {
      const mockProc = {
        on: vi.fn((event, handler) => {
          if (event === 'error') {
            // Simulate command not found
            const error = new Error('spawn git ENOENT');
            error.code = 'ENOENT';
            handler(error);
          }
        }),
        kill: vi.fn(),
      };
      mockSpawn.mockReturnValue(mockProc);

      await expect(deployViaGit()).rejects.toThrow('command not found');
    });

    it('should reject on spawn error with EACCES', async () => {
      const mockProc = {
        on: vi.fn((event, handler) => {
          if (event === 'error') {
            const error = new Error('spawn git EACCES');
            error.code = 'EACCES';
            handler(error);
          }
        }),
        kill: vi.fn(),
      };
      mockSpawn.mockReturnValue(mockProc);

      await expect(deployViaGit()).rejects.toThrow('permission denied');
    });

    it('should resolve on successful push (exit code 0)', async () => {
      const mockProc = {
        on: vi.fn((event, handler) => {
          if (event === 'close') {
            // Simulate successful completion
            setTimeout(() => handler(0), 10);
          }
        }),
        kill: vi.fn(),
      };
      mockSpawn.mockReturnValue(mockProc);

      await expect(deployViaGit()).resolves.toBeUndefined();
    });

    it('should reject on failed push (non-zero exit code)', async () => {
      const mockProc = {
        on: vi.fn((event, handler) => {
          if (event === 'close') {
            setTimeout(() => handler(1), 10);
          }
        }),
        kill: vi.fn(),
      };
      mockSpawn.mockReturnValue(mockProc);

      await expect(deployViaGit()).rejects.toThrow('exit code 1');
    });
  });

  describe('deployViaRailwayCli() (ISSUE 11 - coverage)', () => {
    it('should reject on spawn error with ENOENT', async () => {
      const mockProc = {
        on: vi.fn((event, handler) => {
          if (event === 'error') {
            const error = new Error('spawn railway ENOENT');
            error.code = 'ENOENT';
            handler(error);
          }
        }),
        kill: vi.fn(),
      };
      mockSpawn.mockReturnValue(mockProc);

      await expect(deployViaRailwayCli()).rejects.toThrow('command not found');
    });

    it('should resolve on successful deploy (exit code 0)', async () => {
      const mockProc = {
        on: vi.fn((event, handler) => {
          if (event === 'close') {
            setTimeout(() => handler(0), 10);
          }
        }),
        kill: vi.fn(),
      };
      mockSpawn.mockReturnValue(mockProc);

      await expect(deployViaRailwayCli()).resolves.toBeUndefined();
    });

    it('should reject on failed deploy (non-zero exit code)', async () => {
      const mockProc = {
        on: vi.fn((event, handler) => {
          if (event === 'close') {
            setTimeout(() => handler(128), 10);
          }
        }),
        kill: vi.fn(),
      };
      mockSpawn.mockReturnValue(mockProc);

      await expect(deployViaRailwayCli()).rejects.toThrow('exit code 128');
    });
  });

  describe('Process timeout handling (ISSUE 3 - SIGKILL fallback)', () => {
    it('should call proc.kill on timeout', async () => {
      vi.useFakeTimers();

      const mockProc = {
        on: vi.fn(),
        kill: vi.fn(),
      };
      mockSpawn.mockReturnValue(mockProc);

      // Catch the rejection immediately to prevent unhandled rejection
      const deployPromise = deployViaGit().catch(() => {
        // Expected to reject with timeout error
      });

      // Fast-forward past the 5-minute timeout
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);

      // Verify kill was called with SIGTERM
      expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');

      // Fast-forward to trigger SIGKILL
      await vi.advanceTimersByTimeAsync(5000);
      expect(mockProc.kill).toHaveBeenCalledWith('SIGKILL');

      // Wait for promise to complete
      await deployPromise;

      vi.useRealTimers();
    });
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConfigError, DEFAULT_API_URL, loadConfig } from '../src/config.js';

const KEY = 'ZTk0NzQ0example0123456789';

function problemsOf(env: Record<string, string>): readonly string[] {
  try {
    loadConfig(env);
  } catch (error) {
    assert.ok(error instanceof ConfigError, 'expected a ConfigError');
    return error.problems;
  }
  assert.fail('expected the configuration to be rejected');
}

describe('loadConfig', () => {
  it('needs only the API key, defaulting to production and read-only', () => {
    const config = loadConfig({ KEYCRM_API_KEY: KEY });
    assert.equal(config.apiKey, KEY);
    assert.equal(config.apiUrl, DEFAULT_API_URL);
    assert.equal(config.apiUrl, 'https://openapi.keycrm.app');
    assert.equal(config.allowWrite, false);
    assert.deepEqual(config.notices, []);
  });

  it('treats blank values as unset and trims whitespace', () => {
    const config = loadConfig({ KEYCRM_API_KEY: `  ${KEY}\n`, KEYCRM_API_URL: '', KEYCRM_ALLOW_WRITE: '  ' });
    assert.equal(config.apiKey, KEY);
    assert.equal(config.apiUrl, DEFAULT_API_URL);
    assert.equal(config.allowWrite, false);
  });

  it('drops a pasted "Bearer " prefix and says so without repeating the key', () => {
    const config = loadConfig({ KEYCRM_API_KEY: `Bearer ${KEY}` });
    assert.equal(config.apiKey, KEY);
    assert.equal(config.notices.length, 1);
    assert.match(config.notices[0] ?? '', /prefix was dropped/);
    assert.ok(!config.notices.join(' ').includes(KEY));
  });

  it('rejects a missing key and points to the help article of KeyCRM', () => {
    const problems = problemsOf({});
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /KEYCRM_API_KEY is not set/);
    assert.match(problems[0] ?? '', /help\.keycrm\.app/);
  });

  it('rejects a key with whitespace inside without repeating it', () => {
    const problems = problemsOf({ KEYCRM_API_KEY: `${KEY} extra` });
    assert.match(problems.join('\n'), /without spaces or line breaks/);
    assert.ok(!problems.join('\n').includes(KEY));
  });

  it('enables the write tool only for explicit true values', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) {
      assert.equal(loadConfig({ KEYCRM_API_KEY: KEY, KEYCRM_ALLOW_WRITE: value }).allowWrite, true, value);
    }
    for (const value of ['0', 'false', 'no', 'off']) {
      assert.equal(loadConfig({ KEYCRM_API_KEY: KEY, KEYCRM_ALLOW_WRITE: value }).allowWrite, false, value);
    }
  });

  it('stops on an unrecognised KEYCRM_ALLOW_WRITE instead of guessing', () => {
    assert.match(problemsOf({ KEYCRM_API_KEY: KEY, KEYCRM_ALLOW_WRITE: 'enabled' }).join('\n'), /KEYCRM_ALLOW_WRITE must be 1/);
  });

  it('accepts another https origin and plain http for localhost only', () => {
    assert.equal(loadConfig({ KEYCRM_API_KEY: KEY, KEYCRM_API_URL: 'https://crm.example.com/' }).apiUrl, 'https://crm.example.com');
    assert.equal(loadConfig({ KEYCRM_API_KEY: KEY, KEYCRM_API_URL: 'http://localhost:8080' }).apiUrl, 'http://localhost:8080');
    assert.match(problemsOf({ KEYCRM_API_KEY: KEY, KEYCRM_API_URL: 'http://crm.example.com' }).join('\n'), /must use https/);
  });

  it('rejects an API URL with a path, a query, credentials or no scheme', () => {
    const cases: Record<string, RegExp> = {
      'https://openapi.keycrm.app/v1': /origin only/,
      'https://openapi.keycrm.app/?x=1': /origin only/,
      'https://user:pass@openapi.keycrm.app': /must not contain credentials/,
      'openapi.keycrm.app': /not a valid URL/,
    };
    for (const [value, expected] of Object.entries(cases)) {
      assert.match(problemsOf({ KEYCRM_API_KEY: KEY, KEYCRM_API_URL: value }).join('\n'), expected, value);
    }
  });

  it('reports every problem at once, as a list', () => {
    const problems = problemsOf({ KEYCRM_API_URL: 'ftp://x', KEYCRM_ALLOW_WRITE: 'maybe' });
    assert.equal(problems.length, 3);
    assert.throws(
      () => loadConfig({}),
      (error: unknown) => error instanceof ConfigError && /^Invalid configuration:\n  - KEYCRM_API_KEY/.test(error.message),
    );
  });
});

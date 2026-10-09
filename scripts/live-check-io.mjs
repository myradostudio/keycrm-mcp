// Input and output of the live check.
//
// A live check works with a real key, so two things must not happen: the key
// must not be visible while it is typed, and it must not be printed afterwards.
// `createPrompter` asks questions whose answers are not echoed. `createReporter`
// prints the PASS/FAIL lines through a filter that replaces every registered
// secret, so a key that an API repeats in an error text still does not reach the
// terminal. Both take their streams as arguments, which is how the tests drive
// them without a terminal.

import { createInterface } from 'node:readline';

const HIDDEN = '[hidden]';
/** A shorter value is not replaced: hiding "12" would eat every 12 of the output. */
const MIN_SECRET_LENGTH = 4;

/** Ctrl+C at a question. */
export class Interrupted extends Error {
  constructor() {
    super('Interrupted.');
    this.name = 'Interrupted';
  }
}

/** Thrown inside a check that cannot run: nothing to check it on. Reported as SKIP, not as a failure. */
export class Skip extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'Skip';
  }
}

/** Thrown inside a check after which the rest makes no sense (a rejected key, a used-up rate limit). */
export class Stop extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'Stop';
  }
}

export function expect(condition, message) {
  if (!condition) throw new Error(message);
}

/** Returns the value, or skips the check when an earlier step did not produce it. */
export function need(value, what) {
  if (value === undefined || value === null) throw new Skip(`needs ${what}, which an earlier step did not give`);
  return value;
}

/**
 * Ends the process once everything written so far has reached its destination.
 * `process.exit()` alone can cut the last lines off: Node writes to a terminal
 * asynchronously on Windows. The promise never settles, so nothing runs after it.
 */
export function exitAfterOutput(code, { output = process.stdout, exit = process.exit } = {}) {
  return new Promise(() => {
    output.write('', () => exit(code));
  });
}

/**
 * Asks questions on a terminal or through a pipe.
 *
 * On a terminal the keyboard is read in raw mode, key by key: `secret` shows
 * nothing of the answer, `line` echoes it. From a pipe each question takes the
 * next line. Answers come back trimmed; no answer is an empty string.
 */
export function createPrompter({ input = process.stdin, output = process.stdout } = {}) {
  let nextPipedLine;

  function pipedLine() {
    if (nextPipedLine === undefined) {
      const reader = createInterface({ input, terminal: false });
      const lines = [];
      const waiting = [];
      let closed = false;
      reader.on('line', (line) => {
        const take = waiting.shift();
        if (take === undefined) lines.push(line);
        else take(line);
      });
      reader.on('close', () => {
        closed = true;
        for (const take of waiting.splice(0)) take('');
      });
      nextPipedLine = () => {
        if (lines.length > 0) return Promise.resolve(lines.shift());
        return closed ? Promise.resolve('') : new Promise((resolve) => waiting.push(resolve));
      };
    }
    return nextPipedLine();
  }

  function typed(hidden) {
    return new Promise((resolve, reject) => {
      let answer = '';
      const finish = (settle) => {
        input.off('data', onData);
        input.setRawMode(false);
        input.pause();
        output.write('\n');
        settle();
      };
      const onData = (chunk) => {
        // Arrow keys and the markers of a bracketed paste arrive as escape sequences; none is part of an answer.
        for (const key of String(chunk).replace(/\x1b\[[0-9;]*[A-Za-z~]/g, '')) {
          if (key === '\r' || key === '\n') return finish(() => resolve(answer.trim()));
          if (key === '\x03') return finish(() => reject(new Interrupted()));
          if (key === '\x7f' || key === '\b') {
            if (answer.length > 0 && !hidden) output.write('\b \b');
            answer = answer.slice(0, -1);
          } else if (key >= ' ') {
            answer += key;
            if (!hidden) output.write(key);
          }
        }
        return undefined;
      };
      input.setRawMode(true);
      input.setEncoding('utf8');
      input.resume();
      input.on('data', onData);
    });
  }

  async function ask(question, hidden) {
    output.write(question);
    if (input.isTTY) return typed(hidden);
    const line = await pipedLine();
    output.write('\n');
    return line.trim();
  }

  return {
    /** The answer is not echoed. */
    secret: (question) => ask(question, true),
    /** An ordinary, visible answer. */
    line: (question) => ask(question, false),
  };
}

/**
 * Prints the lines of the check and counts the results.
 *
 * Everything goes through `say`, and `say` replaces each value registered with
 * `hide`. A check is a function: its return value is the detail of the PASS line,
 * an error it throws is the reason of the FAIL line.
 */
export function createReporter({ output = process.stdout } = {}) {
  const secrets = [];
  const counts = { passed: 0, failed: 0, skipped: 0 };

  const clean = (text) => secrets.reduce((result, secret) => result.split(secret).join(HIDDEN), String(text));
  const say = (text = '') => {
    output.write(`${clean(text)}\n`);
  };
  const line = (mark, label, detail) => say(`${mark}  ${label}${detail ? ` — ${String(detail).replace(/\n/g, '\n      ')}` : ''}`);

  return {
    counts,
    say,

    /** Registers values that must never be printed: a key, a phone number, a waybill number. */
    hide(...values) {
      for (const value of values) {
        const text = String(value ?? '').trim();
        if (text.length >= MIN_SECRET_LENGTH && !secrets.includes(text)) secrets.push(text);
      }
      // The longest first, so that a secret containing another one is replaced whole.
      secrets.sort((a, b) => b.length - a.length);
    },

    /**
     * Runs one check and prints its line. Returns true when it passed.
     * @throws {Stop} after printing the FAIL line, when the check asked to stop the run.
     */
    async check(label, run) {
      try {
        const detail = await run();
        counts.passed += 1;
        line('PASS', label, detail);
        return true;
      } catch (error) {
        if (error instanceof Skip) {
          counts.skipped += 1;
          line('SKIP', label, error.message);
          return false;
        }
        counts.failed += 1;
        line('FAIL', label, error instanceof Error ? error.message : error);
        if (error instanceof Stop) throw error;
        return false;
      }
    },

    /** Reports a check that was left out on purpose. */
    skip(label, reason) {
      counts.skipped += 1;
      line('SKIP', label, reason);
    },

    /** Prints the last line and returns the exit code: 1 when anything failed. */
    finish() {
      say('');
      if (counts.failed > 0) say(`${counts.failed} check(s) failed${counts.skipped > 0 ? `, ${counts.skipped} skipped` : ''}.`);
      else if (counts.skipped > 0) say(`All checks that ran passed; ${counts.skipped} skipped, see the SKIP lines.`);
      else say('All checks passed.');
      return counts.failed === 0 ? 0 : 1;
    },
  };
}

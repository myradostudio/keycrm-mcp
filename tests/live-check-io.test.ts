/**
 * The two halves of scripts/live-check-io.mjs: questions whose answers are not
 * shown, and a printer that cannot print a registered secret. The terminal is a
 * stream that says it is one, so the raw-mode path runs without a real console.
 */

import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { describe, it } from 'node:test';

// Plain JavaScript in scripts/, outside the TypeScript sources: loaded by its address, two levels above build-test/tests/.
const io = await import(new URL('../../scripts/live-check-io.mjs', import.meta.url).href);

function screen() {
  let shown = '';
  const output = new Writable({
    write(chunk: Buffer, _encoding, done) {
      shown += chunk.toString();
      done();
    },
  });
  return { output, shown: () => shown };
}

/** A keyboard that reports itself as a terminal and remembers every switch of the raw mode. */
function terminal() {
  const rawModes: boolean[] = [];
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode(mode: boolean) {
      rawModes.push(mode);
    },
  });
  return { input, rawModes, ...screen() };
}

describe('questions on a terminal', () => {
  it('secret: nothing of the answer is shown, and the raw mode is on only while it is typed', async () => {
    const { input, output, shown, rawModes } = terminal();
    const answer = io.createPrompter({ input, output }).secret('Key: ');
    input.write('s3cr');
    input.write('et-value\r');

    assert.equal(await answer, 's3cret-value');
    assert.equal(shown(), 'Key: \n');
    assert.deepEqual(rawModes, [true, false]);
  });

  it('line: the answer is echoed as it is typed', async () => {
    const { input, output, shown } = terminal();
    const answer = io.createPrompter({ input, output }).line('Location id: ');
    input.write('4564\r');

    assert.equal(await answer, '4564');
    assert.equal(shown(), 'Location id: 4564\n');
  });

  it('backspace takes a character back; arrow keys and paste markers add none', async () => {
    const { input, output, shown } = terminal();
    const answer = io.createPrompter({ input, output }).secret('Key: ');
    input.write('12x\x7f3');
    input.write('\x1b[A\x1b[D');
    input.write('\x1b[200~45 \x1b[201~');
    input.write('\n');

    assert.equal(await answer, '12345');
    assert.equal(shown(), 'Key: \n');
  });

  it('Ctrl+C rejects with Interrupted and switches the raw mode off', async () => {
    const { input, output, shown, rawModes } = terminal();
    const answer = io.createPrompter({ input, output }).secret('Key: ');
    input.write('half-a-key\x03');

    await assert.rejects(answer, io.Interrupted);
    assert.deepEqual(rawModes, [true, false]);
    assert.ok(!shown().includes('half'));
  });

  it('asks one question after another on the same terminal', async () => {
    const { input, output, shown, rawModes } = terminal();
    const prompter = io.createPrompter({ input, output });
    const first = prompter.secret('Token: ');
    input.write('token-1\r');
    assert.equal(await first, 'token-1');
    const second = prompter.line('Id: ');
    input.write('77\r');
    assert.equal(await second, '77');

    assert.equal(shown(), 'Token: \nId: 77\n');
    assert.deepEqual(rawModes, [true, false, true, false]);
  });
});

describe('questions through a pipe', () => {
  it('each question takes the next line, shows nothing of it, and the end of the input is an empty answer', async () => {
    const input = new PassThrough();
    const { output, shown } = screen();
    const prompter = io.createPrompter({ input, output });
    input.end('  first-secret \nsecond\n');

    assert.equal(await prompter.secret('One: '), 'first-secret');
    assert.equal(await prompter.line('Two: '), 'second');
    assert.equal(await prompter.secret('Three: '), '');
    assert.equal(shown(), 'One: \nTwo: \nThree: \n');
  });
});

describe('reporter', () => {
  it('hide: a registered value is replaced wherever it would be printed', async () => {
    const { output, shown } = screen();
    const report = io.createReporter({ output });
    report.hide('key-0123456789', '380501234567');

    report.say('started with key-0123456789');
    await report.check('passes', () => 'the API said: phone 380501234567 is unknown');
    await report.check('fails', () => {
      throw new Error('HTTP 401 for key-0123456789\nand again key-0123456789');
    });
    report.skip('skipped', 'nothing for 380501234567');

    assert.equal(
      shown(),
      [
        'started with [hidden]',
        'PASS  passes — the API said: phone [hidden] is unknown',
        'FAIL  fails — HTTP 401 for [hidden]',
        '      and again [hidden]',
        'SKIP  skipped — nothing for [hidden]',
        '',
      ].join('\n'),
    );
  });

  it('hide: a secret that contains another one is replaced whole', () => {
    const { output, shown } = screen();
    const report = io.createReporter({ output });
    report.hide('1234567', '380501234567');

    report.say('phone 380501234567, tail 1234567');

    assert.equal(shown(), 'phone [hidden], tail [hidden]\n');
  });

  it('hide: a value shorter than four characters is left alone, or it would eat the output', () => {
    const { output, shown } = screen();
    const report = io.createReporter({ output });
    report.hide('12', '', undefined);

    report.say('12 of 120 checks');

    assert.equal(shown(), '12 of 120 checks\n');
  });

  it('finish: exit code 0 and "All checks passed." only when nothing failed and nothing was skipped', async () => {
    const { output, shown } = screen();
    const report = io.createReporter({ output });
    assert.equal(await report.check('one', () => undefined), true);

    assert.equal(report.finish(), 0);
    assert.equal(shown(), 'PASS  one\n\nAll checks passed.\n');
  });

  it('finish: a skipped check keeps exit code 0 but changes the last line', async () => {
    const { output, shown } = screen();
    const report = io.createReporter({ output });
    await report.check('one', () => 'fine');
    assert.equal(
      await report.check('two', () => io.need(undefined, 'an order')),
      false,
    );

    assert.equal(report.finish(), 0);
    assert.deepEqual(report.counts, { passed: 1, failed: 0, skipped: 1 });
    assert.match(shown(), /^SKIP  two — needs an order, which an earlier step did not give$/m);
    assert.match(shown(), /\nAll checks that ran passed; 1 skipped, see the SKIP lines\.\n$/);
  });

  it('finish: one failed check is exit code 1', async () => {
    const { output, shown } = screen();
    const report = io.createReporter({ output });
    await report.check('one', () => 'fine');
    assert.equal(
      await report.check('two', () => io.expect(1 + 1 === 3, 'the sum is wrong')),
      false,
    );
    await report.check('three', () => {
      throw new io.Skip('nothing to look at');
    });

    assert.equal(report.finish(), 1);
    assert.match(shown(), /^FAIL  two — the sum is wrong$/m);
    assert.match(shown(), /\n1 check\(s\) failed, 1 skipped\.\n$/);
  });

  it('check: Stop is printed as a failure and then thrown on, so that the run ends there', async () => {
    const { output, shown } = screen();
    const report = io.createReporter({ output });

    await assert.rejects(
      report.check('one', () => {
        throw new io.Stop('the key was rejected');
      }),
      io.Stop,
    );
    assert.equal(shown(), 'FAIL  one — the key was rejected\n');
    assert.equal(report.finish(), 1);
  });

  it('exitAfterOutput: the process ends only after the last line has been written out', () => {
    // A terminal that takes its time: every chunk waits until the test lets it through.
    const waiting: (() => void)[] = [];
    let shown = '';
    const output = new Writable({
      write(chunk: Buffer, _encoding, done) {
        waiting.push(() => {
          shown += chunk.toString();
          done();
        });
      },
    });
    const exits: number[] = [];
    const report = io.createReporter({ output });

    report.say('the last line');
    void io.exitAfterOutput(3, { output, exit: (code: number) => exits.push(code) });

    assert.deepEqual(exits, [], 'not while the line is still on its way');
    while (waiting.length > 0) waiting.shift()?.();
    assert.equal(shown, 'the last line\n');
    assert.deepEqual(exits, [3]);
  });

  it('need: passes a value through and accepts 0 and an empty string as values', () => {
    assert.equal(io.need(0, 'a number'), 0);
    assert.equal(io.need('', 'a text'), '');
    assert.throws(() => io.need(null, 'a card'), io.Skip);
  });
});

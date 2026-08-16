import assert from 'node:assert/strict';
import { afterEach, describe, it, vi } from 'vitest';
import { copyText } from './clipboard.ts';

const original = navigator.clipboard;

afterEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    value: original,
    configurable: true,
    writable: true,
  });
});

describe('copyText', () => {
  it('resolves true when navigator.clipboard.writeText succeeds', async () => {
    let calledWith = '';
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (text: string) => {
          calledWith = text;
        },
      },
      configurable: true,
      writable: true,
    });

    const ok = await copyText('hello');
    assert.ok(ok);
    assert.equal(calledWith, 'hello');
  });

  it('falls back without throwing when navigator.clipboard is absent', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
      writable: true,
    });

    // jsdom does not implement execCommand, so the fallback itself fails —
    // the point of this test is that copyText still resolves instead of
    // throwing, reporting the failure through its return value.
    const ok = await copyText('hello');
    assert.equal(ok, false);
  });

  // The test above only pins the failure path; jsdom's lack of execCommand
  // means a broken/removed fallback implementation would pass it too. Stub
  // execCommand so the success path — and what it actually selects and
  // cleans up — is checked directly.
  it('copies via document.execCommand when navigator.clipboard is absent', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
      writable: true,
    });

    let capturedCommand = '';
    let selectedValue = '';
    const execCommand = vi.fn((command: string) => {
      capturedCommand = command;
      // The textarea copyText builds is the focused element with its text
      // selected at the point execCommand runs — that is what proves the
      // requested string, not whatever else was on the page, gets copied.
      const active = document.activeElement as HTMLTextAreaElement | null;
      selectedValue = active?.value ?? '';
      return true;
    });
    // jsdom does not implement execCommand at all; this test only exists to
    // stub it, so the doc has no original implementation to preserve.
    (document as unknown as { execCommand: typeof execCommand }).execCommand =
      execCommand;

    try {
      const ok = await copyText('hello world');
      assert.equal(ok, true);
      assert.equal(capturedCommand, 'copy');
      assert.equal(selectedValue, 'hello world');
      assert.equal(document.querySelectorAll('textarea').length, 0);
    } finally {
      delete (document as unknown as { execCommand?: typeof execCommand })
        .execCommand;
    }
  });
});

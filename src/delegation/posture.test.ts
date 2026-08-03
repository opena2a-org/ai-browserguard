import { describe, it, expect } from 'vitest';
import {
  chromeMajorVersion,
  remoteDebuggingPosture,
  DEFAULT_PROFILE_PROTECTED_SINCE,
} from './posture';

describe('chromeMajorVersion', () => {
  it('parses a desktop Chrome UA', () => {
    expect(chromeMajorVersion(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.77 Safari/537.36',
    )).toBe(145);
  });

  it('parses exactly the boundary version', () => {
    expect(chromeMajorVersion('x Chrome/136.0.0.0 y')).toBe(136);
  });

  it('returns null when no Chrome token exists', () => {
    expect(chromeMajorVersion('Mozilla/5.0 (X11; Linux) Gecko/20100101 Firefox/128.0')).toBeNull();
    expect(chromeMajorVersion('')).toBeNull();
  });

  it('is not fooled by a bare "Chrome" without a version', () => {
    expect(chromeMajorVersion('Chrome/x.y')).toBeNull();
    expect(chromeMajorVersion('HeadlessChrome without slash')).toBeNull();
  });

  it('rejects a zero or negative major', () => {
    expect(chromeMajorVersion('Chrome/0.0.0.0')).toBeNull();
  });
});

describe('remoteDebuggingPosture', () => {
  it('says nothing when the version is unknown — no guessing', () => {
    expect(remoteDebuggingPosture(null)).toBeNull();
  });

  it('on a protected version, explains what the agent presence implies', () => {
    const line = remoteDebuggingPosture(DEFAULT_PROFILE_PROTECTED_SINCE);
    expect(line).toContain('already refuses remote debugging');
    expect(line).toContain('separate profile');
    // Honesty guard: the line must never read as containment of THIS agent —
    // its presence proves it crossed the protection.
    expect(line?.toLowerCase()).not.toContain('this agent is blocked');
    expect(line?.toLowerCase()).not.toContain('protected from this agent');
  });

  it('below the boundary, names the concrete fix (update), not just the exposure', () => {
    const line = remoteDebuggingPosture(DEFAULT_PROFILE_PROTECTED_SINCE - 1);
    expect(line).toContain('Updating Chrome');
    expect(line).toContain(String(DEFAULT_PROFILE_PROTECTED_SINCE));
  });

  it('the boundary itself counts as protected', () => {
    expect(remoteDebuggingPosture(136)).toContain('already refuses');
    expect(remoteDebuggingPosture(135)).toContain('Updating Chrome');
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, existsSync, lstatSync, rmSync, writeFileSync } from 'fs';
import { tmpdir, hostname } from 'os';
import { join } from 'path';
import { clearStaleProfileLock } from '../services/browser.service.js';

function profileWithLock(target: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cdm-lock-'));
  symlinkSync(target, join(dir, 'SingletonLock'));
  symlinkSync('12345', join(dir, 'SingletonCookie'));
  writeFileSync(join(dir, 'Preferences'), '{}');
  return dir;
}

const exists = (p: string) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

test('a lock from another host (a previous container) is removed', () => {
  const dir = profileWithLock('9bfe90e925c2-565');
  try {
    assert.equal(clearStaleProfileLock(dir, 'new-container'), true);
    assert.equal(exists(join(dir, 'SingletonLock')), false);
    assert.equal(exists(join(dir, 'SingletonCookie')), false);
    assert.ok(existsSync(join(dir, 'Preferences')), 'the profile itself is kept');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a lock from a dead process on this host is removed', () => {
  const dir = profileWithLock(`${hostname()}-999999`);
  try {
    assert.equal(clearStaleProfileLock(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a lock held by a live process on this host is kept', () => {
  const dir = profileWithLock(`${hostname()}-${process.pid}`);
  try {
    assert.equal(clearStaleProfileLock(dir), false);
    assert.ok(exists(join(dir, 'SingletonLock')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no lock, nothing to do', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cdm-lock-'));
  try {
    assert.equal(clearStaleProfileLock(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

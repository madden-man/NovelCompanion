import { inject } from 'vitest';
import { ulid } from 'ulid';
import { connect } from '../../src/main/db';
import type { Store } from '../../src/main/db';

/** Connect to the suite's local MongoDB. Never Atlas. */
export async function localStore(): Promise<Store> {
  const uri = inject('mongoUri');
  if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)/.test(uri)) {
    throw new Error('Integration tests only run against a local MongoDB.');
  }
  return connect(uri);
}

/** A bible ID no other test uses. All tests share the one `novel_companion` database. */
export function freshSlug(prefix: string): string {
  return `${prefix}-${ulid().toLowerCase()}`.slice(0, 40);
}

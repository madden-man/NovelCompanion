import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  bibleMarkdown,
  changeSummary,
  knownFrom,
  classifyFiles,
  driveKind,
  exportFolderName,
  htmlToMarkdown,
  importFileName,
  safeName,
} from '../../src/shared/domain/drive';
import type { DriveLink } from '../../src/shared/domain/drive';
import { contract, parseResponse } from '../../src/shared/ipc';

const stored = new Map<string, string>();
vi.mock('@napi-rs/keyring', () => ({
  Entry: class {
    constructor(
      private service: string,
      private account: string,
    ) {}
    getPassword() {
      return stored.get(`${this.service}/${this.account}`) ?? null;
    }
    setPassword(v: string) {
      stored.set(`${this.service}/${this.account}`, v);
    }
    deletePassword() {
      return stored.delete(`${this.service}/${this.account}`);
    }
  },
}));

const { GOOGLE_ENDPOINTS, SCOPE_FILE, SCOPE_READONLY, authUrl, pkcePair } =
  await import('../../src/main/drive/oauth');
const { GOOGLE_KEYCHAIN_SERVICE, keychainStore } = await import('../../src/main/drive/secrets');

const ROOT = join(import.meta.dirname, '../..');

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

describe('GD-1 scopes, PKCE, and where secrets live', () => {
  test('GD-1 the scopes are drive.readonly for import and drive.file for export, nothing broader', () => {
    expect(SCOPE_READONLY).toBe('https://www.googleapis.com/auth/drive.readonly');
    expect(SCOPE_FILE).toBe('https://www.googleapis.com/auth/drive.file');
    const source = filesUnder(join(ROOT, 'src'))
      .map((p) => readFileSync(p, 'utf8'))
      .join('\n');
    expect(source).not.toMatch(/auth\/drive['"\s]/);
    expect(source).not.toMatch(/auth\/drive\.(metadata|appdata|photos)/);
  });

  test('GD-1 the consent URL is Google desktop flow: code, S256 challenge, loopback redirect, offline', () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    const url = new URL(
      authUrl(GOOGLE_ENDPOINTS, {
        clientId: 'id.apps.googleusercontent.com',
        redirectUri: 'http://127.0.0.1:51234',
        scopes: [SCOPE_READONLY],
        challenge,
        state: 'abc',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'id.apps.googleusercontent.com',
      redirect_uri: 'http://127.0.0.1:51234',
      response_type: 'code',
      scope: SCOPE_READONLY,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'abc',
      access_type: 'offline',
      prompt: 'consent',
    });
  });

  test('GD-1 ARCH-5 the client and tokens go to the keychain under novel-companion-google', () => {
    const store = keychainStore();
    store.set('oauth-tokens', '{"refreshToken":"x"}');
    expect(GOOGLE_KEYCHAIN_SERVICE).toBe('novel-companion-google');
    expect(stored.get('novel-companion-google/oauth-tokens')).toBe('{"refreshToken":"x"}');
    store.delete('oauth-tokens');
    expect(store.get('oauth-tokens')).toBeNull();
  });

  test('ARCH-1 the renderer never names a Google host, and no Drive response carries a secret', () => {
    const renderer = filesUnder(join(ROOT, 'src/renderer'))
      .map((p) => readFileSync(p, 'utf8'))
      .join('\n');
    expect(renderer).not.toMatch(/googleapis\.com|accounts\.google\.com/);
    const index = readFileSync(join(ROOT, 'src/main/index.ts'), 'utf8');
    expect(index).not.toMatch(/google/i);
    const status = {
      clientConfigured: true,
      clientIdHint: 'x',
      connected: true,
      email: null,
      canExport: false,
    };
    expect(parseResponse('drive.status', status)).toEqual(status);
    expect(() => parseResponse('drive.status', { ...status, refreshToken: 'rt' })).toThrow();
    expect(() => parseResponse('drive.status', { ...status, clientSecret: 's' })).toThrow();
    expect(Object.keys(contract).filter((c) => c.startsWith('drive.'))).toHaveLength(16);
  });
});

describe('GD-2 supported kinds', () => {
  test('GD-2 Word, Excel, Google Docs, Google Sheets, and folders; anything else is other', () => {
    expect(driveKind('application/vnd.google-apps.document')).toBe('document');
    expect(driveKind('application/vnd.google-apps.spreadsheet')).toBe('workbook');
    expect(
      driveKind('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    ).toBe('document');
    expect(driveKind('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe(
      'workbook',
    );
    expect(driveKind('application/vnd.google-apps.folder')).toBe('folder');
    expect(driveKind('application/octet-stream', 'Old.xlsx')).toBe('workbook');
    expect(driveKind('application/pdf', 'Map.pdf')).toBe('other');
    expect(driveKind('application/vnd.google-apps.presentation')).toBe('other');
  });

  test('GD-2 IM-6 a Google file is recorded under its name with the Office extension', () => {
    expect(importFileName('Chapter 3', 'application/vnd.google-apps.document')).toBe(
      'Chapter 3.docx',
    );
    expect(importFileName('World', 'application/vnd.google-apps.spreadsheet')).toBe('World.xlsx');
    expect(
      importFileName(
        'World.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ),
    ).toBe('World.xlsx');
  });
});

describe('GD-3 change detection', () => {
  const links: DriveLink[] = [
    {
      id: 'F',
      name: 'Novel',
      mimeType: 'application/vnd.google-apps.folder',
      kind: 'folder',
      linkedAt: '',
    },
    {
      id: 'gone',
      name: 'Gone',
      mimeType: 'application/vnd.google-apps.document',
      kind: 'document',
      linkedAt: '',
    },
  ];
  const sheet = 'application/vnd.google-apps.spreadsheet';

  test('GD-3 new, changed, unchanged, and missing, changed first; one file reached twice counts once', () => {
    const files = classifyFiles(
      links,
      [
        { id: 'a', name: 'A', mimeType: sheet, modifiedTime: '2026-02-01T00:00:00Z', linkId: 'F' },
        { id: 'b', name: 'B', mimeType: sheet, modifiedTime: '2026-01-01T00:00:00Z', linkId: 'F' },
        { id: 'c', name: 'C', mimeType: sheet, modifiedTime: '2026-01-01T00:00:00Z', linkId: 'F' },
        { id: 'c', name: 'C', mimeType: sheet, modifiedTime: '2026-01-01T00:00:00Z', linkId: 'x' },
        { id: 'p', name: 'P', mimeType: 'application/pdf', modifiedTime: '', linkId: 'F' },
      ],
      ['gone'],
      [
        { fileId: 'a', modifiedTime: '2026-01-01T00:00:00.000Z', at: '' },
        { fileId: 'b', modifiedTime: '2026-01-01T00:00:00.000Z', at: '' },
      ],
    );
    expect(files.map((f) => [f.fileId, f.state])).toEqual([
      ['a', 'changed'],
      ['c', 'new'],
      ['gone', 'missing'],
      ['b', 'unchanged'],
    ]);
    expect(changeSummary(files)).toBe(
      '3 linked Drive files: 1 changed since you last imported, 1 not imported yet, 1 no longer in Drive. Nothing changes until you review it.',
    );
    expect(changeSummary(files.filter((f) => f.state === 'unchanged'))).toBe(
      'Every linked Drive file matches what you imported.',
    );
  });
});

describe('GD-3 files remembered from an earlier check', () => {
  const sheet = 'application/vnd.google-apps.spreadsheet';
  const link = (id: string, kind: 'folder' | 'workbook') => ({
    id,
    name: id,
    mimeType: kind === 'folder' ? 'application/vnd.google-apps.folder' : sheet,
    kind,
    linkedAt: '',
  });
  const remote = [
    { id: 'a', name: 'A', mimeType: sheet, modifiedTime: '2026-01-01T00:00:00Z', linkId: 'F' },
  ];
  const known = knownFrom([
    ...remote,
    { id: 'b', name: 'B', mimeType: sheet, modifiedTime: '2026-01-01T00:00:00Z', linkId: 'F' },
    { id: 'pdf', name: 'P', mimeType: 'application/pdf', modifiedTime: '', linkId: 'F' },
  ]);

  test('GD-3 a remembered file the folder no longer returns is missing; a folder that could not be read or is itself missing hides nothing', () => {
    expect(known.map((k) => k.fileId)).toEqual(['a', 'b']);
    const folder = [link('F', 'folder')];
    const states = (missing: string[], unreadable: string[]) =>
      classifyFiles(folder, remote, missing, [], known, unreadable).map((f) => [f.fileId, f.state]);
    expect(states([], [])).toEqual([
      ['b', 'missing'],
      ['a', 'new'],
    ]);
    expect(states([], ['F'])).toEqual([['a', 'new']]);
    expect(states(['F'], [])).toEqual([['a', 'new']]);
    // Remembered files of an unlinked folder are not reported.
    expect(classifyFiles([link('G', 'folder')], remote, [], [], known, [])).toHaveLength(1);
  });
});

describe('GD-4 Markdown export', () => {
  test('GD-4 stored HTML becomes Markdown: headings, italics, bold, lists, scene breaks, entities', () => {
    expect(
      htmlToMarkdown(
        '<h1>Chapter 3</h1><p>It was <em>lucky</em> &amp; <strong>loud</strong>.</p><hr><ul><li>one</li><li>two</li></ul><ol><li>first</li></ol><p>a<br>b</p>',
      ),
    ).toBe(
      '# Chapter 3\n\nIt was *lucky* & **loud**.\n\n***\n\n- one\n- two\n\n1. first\n\na  \nb',
    );
    expect(htmlToMarkdown('plain text')).toBe('plain text');
    expect(htmlToMarkdown('')).toBe('');
  });

  test('GD-4 one file per entry, a folder per section, custom sections by their own name, trash left out', () => {
    const folders = bibleMarkdown({
      bibleName: 'East Winds',
      lists: [{ _id: 'unionTypes', items: [{ id: 'married', label: 'Married' }] }],
      collections: {
        characters: [
          {
            _id: 'H1',
            title: 'Margaret Hale',
            status: 'canon',
            provenance: 'invented',
            body: '<p>A <em>teacher</em>.</p>',
            birth: { year: 1958 },
            tags: ['matriarch'],
            links: [{ targetId: 'H2', kind: 'spouse' }],
          },
          { _id: 'H2', title: 'Peter Hale', status: 'canon', birth: { unknown: true } },
          { _id: 'H9', title: 'Trashed', status: 'idea', deletedAt: '2026-01-01T00:00:00Z' },
        ],
        customSections: [
          { _id: 'S1', title: '', name: 'Recipes', fields: [{ id: 'f1', label: 'Dish' }] },
        ],
        customEntries: [
          {
            _id: 'C1',
            title: 'Dumplings',
            status: 'idea',
            sectionId: 'S1',
            values: { f1: 'Jiaozi' },
          },
        ],
      },
    });
    expect(folders.map((f) => f.folder)).toEqual(['Characters', 'Custom sections', 'Recipes']);
    const people = folders[0]!.files;
    expect(people.map((f) => f.name)).toEqual(['Margaret Hale (H1).md', 'Peter Hale (H2).md']);
    const m = people[0]!.content;
    expect(m).toContain('# Margaret Hale\n');
    expect(m).toContain('- **Status**: Canon');
    expect(m).toContain('- **Tags**: matriarch');
    expect(m).toContain('1958');
    expect(m).toContain('A *teacher*.');
    expect(m).toContain('## Links\n\n- spouse: Peter Hale (Character)');
    expect(people[1]!.content).toContain('unknown');
    const recipe = folders[2]!.files[0]!.content;
    expect(recipe).toContain('- **Dish**: Jiaozi');
    expect(recipe).toContain('- **Section**: Recipes');
  });

  test('GD-4 names are safe for Drive and every desktop system; export folders are dated', () => {
    expect(safeName('a/b: c?')).toBe('a b c');
    expect(safeName('   ')).toBe('Untitled');
    expect(exportFolderName('East Winds', new Date('2026-10-11T09:08:07.123Z'))).toBe(
      'East Winds 2026-10-11 09-08-07Z',
    );
  });
});

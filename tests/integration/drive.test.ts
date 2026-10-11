import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createBibleWithDefaults, openBibleSession } from '../../src/main/db/session';
import type { OpenBible } from '../../src/main/db/session';
import { createBible } from '../../src/main/db';
import type { Store } from '../../src/main/db';
import { dumpBible } from '../../src/main/backup/dump';
import { importBibleJson } from '../../src/main/backup/json';
import { DriveService } from '../../src/main/drive/service';
import { fetchDriveFile, setDriveService } from '../../src/main/drive';
import { endpointsAt } from '../../src/main/drive/oauth';
import { CLIENT_ACCOUNT, TOKENS_ACCOUNT, memoryStore } from '../../src/main/drive/secrets';
import { driveHandlers } from '../../src/main/ipc/driveHandlers';
import type { DriveChannel } from '../../src/main/ipc/driveHandlers';
import type { ImportBridge } from '../../src/main/ipc/importHandlers';
import { runHandler } from '../../src/main/ipc/validate';
import type { Handler } from '../../src/main/ipc/validate';
import { parseDocxBuffer } from '../../src/main/import/docx';
import type { TableMapping } from '../../src/shared/domain/import';
import type { Channel, Request, Response } from '../../src/shared/ipc';
import { freshSlug, localStore } from '../helpers/db';
import { FIXTURE_WORKBOOK } from '../helpers/importSim';
import { loadFixture, readFixture } from '../helpers/loadFixture';
import { ipcFor } from '../helpers/ipc';
import { FILE, READONLY, startFakeGoogle } from '../helpers/fakeGoogle';
import type { FakeGoogle } from '../helpers/fakeGoogle';

const DOCX = join(import.meta.dirname, '../../fixtures/files/chapter-03.docx');
const GDOC = 'application/vnd.google-apps.document';
const GSHEET = 'application/vnd.google-apps.spreadsheet';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const people: TableMapping = {
  shape: 'table',
  sheet: 'People',
  target: { collection: 'characters' },
  headerRow: 1,
  columns: [
    { header: 'Name', index: 1, field: 'title' },
    { header: 'Chinese name', index: 2, field: 'names.chinese' },
    { header: 'Born', index: 3, field: 'birth' },
    { header: 'Died', index: 4, field: 'death' },
    { header: 'Family', index: 5, field: 'familyIds' },
    { header: 'Notes', index: 6, field: 'sourceNote' },
  ],
  identity: ['title'],
  fixed: { status: 'canon', provenance: 'invented' },
  addMissingListItems: false,
  createMissing: true,
  matchIn: 'sheet',
  headings: [],
};

let store: Store;
let root: string;
let fake: FakeGoogle;
let secrets: ReturnType<typeof memoryStore>;
let service: DriveService;
let docxBytes: Buffer;
let xlsxBytes: Buffer;

beforeAll(async () => {
  store = await localStore();
  root = await mkdtemp(join(tmpdir(), 'nc-drive-'));
  docxBytes = await readFile(DOCX);
  xlsxBytes = await readFile(FIXTURE_WORKBOOK);
});
afterAll(async () => {
  await store.close();
});

beforeEach(async () => {
  fake = await startFakeGoogle({ email: 'tommy@example.com' });
  // Novel/ (a folder) holds a Google Doc, a Google Sheet, an uploaded Word file, and a PDF.
  fake.addFile({
    id: 'folderNovel',
    name: 'Novel',
    mimeType: 'application/vnd.google-apps.folder',
  });
  fake.addFile({
    id: 'docCh3',
    name: 'Chapter 3',
    mimeType: GDOC,
    parents: ['folderNovel'],
    content: docxBytes,
  });
  fake.addFile({
    id: 'sheetWorld',
    name: 'fixture-workbook',
    mimeType: GSHEET,
    parents: ['folderNovel'],
    content: xlsxBytes,
    modifiedTime: '2026-01-15T09:00:00.000Z',
  });
  fake.addFile({
    id: 'wordBack',
    name: 'Backstory.docx',
    mimeType: DOCX_MIME,
    parents: ['folderNovel'],
    content: docxBytes,
  });
  fake.addFile({
    id: 'pdfMap',
    name: 'Map.pdf',
    mimeType: 'application/pdf',
    parents: ['folderNovel'],
  });
  fake.addFile({ id: 'sheetLoose', name: 'Loose sheet', mimeType: GSHEET, content: xlsxBytes });
  secrets = memoryStore();
  service = new DriveService({
    secrets,
    endpoints: endpointsAt(fake.base),
    // Stands in for the system browser: Google's consent page redirects to the loopback listener.
    openBrowser: async (url) => void (await fetch(url)),
    authTimeoutMs: 5000,
  });
});
afterEach(async () => {
  setDriveService(null);
  await fake.close();
});

type Invoke = <C extends Channel>(channel: C, request: Request<C>) => Promise<Response<C>>;

/** The import channels and the Drive channels over the same contract, as main wires them. */
function wire(open: OpenBible | null): Invoke {
  let bridge: ImportBridge | null = null;
  let applied: ((o: string) => Promise<void>) | null = null;
  const importInvoke = ipcFor(() => open, {
    bridge: (b) => (bridge = b),
    onApplied: (o) => applied?.(o),
  });
  const drive = driveHandlers(
    () => open,
    () => service,
    () => bridge,
  );
  applied = drive.onApplied;
  return async (channel, request) => {
    if (channel.startsWith('drive.')) {
      const handler = drive.handlers[channel as DriveChannel] as Handler<typeof channel>;
      const response = await runHandler(channel, handler, JSON.parse(JSON.stringify(request)));
      return JSON.parse(JSON.stringify(response)) as Response<typeof channel>;
    }
    return importInvoke(channel, request);
  };
}

async function emptyBible(label: string): Promise<OpenBible> {
  const open = await createBibleWithDefaults(store, freshSlug(label), label);
  return openBibleSession(store, open.handle.id, { snapshotRoot: root });
}

async function connected(invoke: Invoke) {
  await invoke('drive.setClient', { clientId: fake.clientId, clientSecret: fake.clientSecret });
  return invoke('drive.connect', {});
}

/** The fixture workbook with Margaret Hale's birth year changed. */
async function editedWorkbook(born: number): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsxBytes as unknown as ArrayBuffer);
  wb.getWorksheet('People')!.getRow(2).getCell(4).value = born;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('GD-1 desktop sign-in, read-only for import, secrets in the keychain only', () => {
  test('GD-1 connect runs the loopback flow with PKCE and asks only for drive.readonly', async () => {
    const open = await emptyBible('gd-connect');
    const invoke = wire(open);
    expect(await invoke('drive.status', {})).toMatchObject({
      clientConfigured: false,
      connected: false,
    });
    await expect(invoke('drive.connect', {})).rejects.toThrow(/not set up/);
    const status = await connected(invoke);
    expect(status).toEqual({
      clientConfigured: true,
      clientIdHint: expect.stringMatching(/^123456…ghij\.apps\.googleusercontent\.com$/),
      connected: true,
      email: 'tommy@example.com',
      canExport: false,
    });
    const auth = fake.lastAuth!;
    expect(auth.get('scope')).toBe(READONLY);
    expect(auth.get('response_type')).toBe('code');
    expect(auth.get('code_challenge_method')).toBe('S256');
    expect(auth.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(auth.get('access_type')).toBe('offline');
    expect(auth.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const form = fake.lastTokenForm!;
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(form.get('redirect_uri')).toBe(auth.get('redirect_uri'));

    // Tokens and the client live only in the secret store, never in the bible or a response.
    const kept = secrets.dump();
    const tokens = JSON.parse(kept[TOKENS_ACCOUNT]!) as { refreshToken: string; scopes: string[] };
    expect(tokens.refreshToken).toMatch(/^rt-/);
    expect(tokens.scopes).toEqual([READONLY]);
    expect(JSON.parse(kept[CLIENT_ACCOUNT]!)).toEqual({
      clientId: fake.clientId,
      clientSecret: fake.clientSecret,
    });
    await invoke('drive.link', { ids: ['docCh3'] });
    const everything = JSON.stringify(await dumpBible(open.handle));
    expect(everything).not.toContain(tokens.refreshToken);
    expect(everything).not.toContain(fake.clientSecret);
    expect(JSON.stringify(status)).not.toContain(fake.clientSecret);
  });

  test('GD-1 a declined consent or an unticked Drive box leaves Drive disconnected with a plain reason', async () => {
    const invoke = wire(null);
    await invoke('drive.setClient', { clientId: fake.clientId, clientSecret: fake.clientSecret });
    fake.consent = { deny: true };
    await expect(invoke('drive.connect', {})).rejects.toThrow(/access was declined/);
    fake.consent = { grant: [] };
    await expect(invoke('drive.connect', {})).rejects.toThrow(/left unticked/);
    expect((await invoke('drive.status', {})).connected).toBe(false);
    expect(secrets.dump()[TOKENS_ACCOUNT]).toBeUndefined();
  });

  test('GD-1 a malformed client ID is refused before anything is stored', async () => {
    const invoke = wire(null);
    await expect(
      invoke('drive.setClient', { clientId: 'not-a-client', clientSecret: 'GOCSPX-abcdefgh' }),
    ).rejects.toThrow(/ends in \.apps\.googleusercontent\.com/);
    expect(secrets.dump()).toEqual({});
  });

  test('GD-1 an expired refresh token disconnects and says to connect again', async () => {
    const open = await emptyBible('gd-expired');
    const invoke = wire(open);
    await connected(invoke);
    // Force a refresh: the stored access token is already expired.
    const t = JSON.parse(secrets.get(TOKENS_ACCOUNT)!) as Record<string, unknown>;
    secrets.set(TOKENS_ACCOUNT, JSON.stringify({ ...t, expiresAt: 0 }));
    fake.expireRefreshTokens();
    await expect(invoke('drive.browse', {})).rejects.toThrow(/Connect again in Settings/);
    expect((await invoke('drive.status', {})).connected).toBe(false);
  });
});

describe('GD-2 choose files and folders; Word, Excel, Google Docs, and Google Sheets import', () => {
  test('GD-2 browse lists My Drive and a folder with kinds; a PDF cannot be linked', async () => {
    const open = await emptyBible('gd-browse');
    const invoke = wire(open);
    await connected(invoke);
    const top = await invoke('drive.browse', {});
    expect(top.items.map((i) => [i.name, i.kind])).toEqual([
      ['Novel', 'folder'],
      ['Loose sheet', 'workbook'],
    ]);
    const inside = await invoke('drive.browse', { folderId: 'folderNovel' });
    expect(inside.folder).toEqual({ id: 'folderNovel', name: 'Novel' });
    expect(Object.fromEntries(inside.items.map((i) => [i.name, i.kind]))).toEqual({
      'Backstory.docx': 'document',
      'Chapter 3': 'document',
      'fixture-workbook': 'workbook',
      'Map.pdf': 'other',
    });
    const found = await invoke('drive.browse', { search: 'chap' });
    expect(found.items.map((i) => i.id)).toEqual(['docCh3']);
    await expect(invoke('drive.link', { ids: ['pdfMap'] })).rejects.toThrow(/cannot be linked/);
    const { links } = await invoke('drive.link', { ids: ['folderNovel', 'sheetLoose'] });
    expect(links.map((l) => [l.id, l.kind])).toEqual([
      ['folderNovel', 'folder'],
      ['sheetLoose', 'workbook'],
    ]);
    // Linking twice adds nothing; links are per bible and survive a reopen.
    await invoke('drive.link', { ids: ['sheetLoose'] });
    const again = await openBibleSession(store, open.handle.id);
    expect(again.repo.driveState().links).toHaveLength(2);
    expect((await invoke('drive.unlink', { id: 'sheetLoose' })).links).toHaveLength(1);
  });

  test('GD-2 a Google Doc is exported as Word and imports through the M5 pipeline with italics and its source', async () => {
    const open = await emptyBible('gd-doc');
    const invoke = wire(open);
    await connected(invoke);
    const { file } = await invoke('drive.open', { fileId: 'docCh3' });
    expect(file).toMatchObject({ name: 'Chapter 3.docx', kind: 'document' });
    expect(fake.calls).toContain('GET /drive/v3/files/docCh3/export');
    const doc = await invoke('import.document', { fileId: file.id });
    expect(doc.body).toContain('<em>lucky</em>');
    const plan = await invoke('import.documentPlan', {
      fileId: file.id,
      target: { kind: 'note', title: 'Wedding notes' },
    });
    expect(plan.created).toBe(1);
    await invoke('import.apply', { planId: plan.planId, approved: plan.items.map((i) => i.id) });
    const entry = open.repo.list('customEntries').find((e) => e.title === 'Wedding notes')!;
    expect(entry.body).toContain('<em>lucky</em>');
    expect(entry.sourceRef).toBe('Chapter 3.docx#p1-p4');
  });

  test('GD-2 an uploaded Word file is downloaded as it is', async () => {
    const open = await emptyBible('gd-word');
    const invoke = wire(open);
    await connected(invoke);
    const { file } = await invoke('drive.open', { fileId: 'wordBack' });
    expect(file.name).toBe('Backstory.docx');
    expect(fake.calls).not.toContain('GET /drive/v3/files/wordBack/export');
    expect((await invoke('import.document', { fileId: file.id })).headings[0]!.text).toBe(
      'Chapter 3: Wedding Weather',
    );
  });

  test('GD-2 a Google Sheet is exported as Excel and maps, compares, and applies with a saved mapping', async () => {
    const open = await emptyBible('gd-sheet');
    const invoke = wire(open);
    await connected(invoke);
    const { file } = await invoke('drive.open', { fileId: 'sheetWorld' });
    expect(file).toMatchObject({
      name: 'fixture-workbook.xlsx',
      kind: 'workbook',
      modifiedAt: '2026-01-15T09:00:00.000Z',
    });
    const wb = await invoke('import.workbook', { fileId: file.id });
    expect(wb.sheets.map((s) => s.name)).toContain('People');
    const plan = await invoke('import.plan', { fileId: file.id, mapping: people });
    expect(plan.created).toBeGreaterThan(0);
    const done = await invoke('import.apply', {
      planId: plan.planId,
      approved: plan.items.map((i) => i.id),
    });
    expect(done.created).toBe(plan.created);
    const margaret = open.repo.list('characters').find((c) => c.title === 'Margaret Hale')!;
    expect(margaret.birth).toEqual({ year: 1958 });
    expect(margaret.sourceRef).toMatch(/^fixture-workbook\.xlsx#People!/);
    // The mapping is saved under the same name a downloaded copy would have.
    expect((await invoke('import.workbook', { fileId: file.id })).saved[0]!.sheet).toBe('People');
  });

  test('GD-2 MS-1 fetchDriveFile hands M7 a Google Doc as .docx bytes the Word importer reads', async () => {
    setDriveService(service);
    await connected(wire(null));
    const f = await fetchDriveFile('docCh3');
    expect(f).toMatchObject({ fileName: 'Chapter 3.docx', kind: 'document', mimeType: GDOC });
    const parsed = await parseDocxBuffer(f.data, f);
    expect(parsed.html).toContain('<em>lucky</em>');
    await expect(fetchDriveFile('pdfMap')).rejects.toThrow(/Word, Excel, Google Docs/);
  });
});

describe('GD-3 changed linked files are reported, and nothing applies without the comparison', () => {
  test('GD-3 a check lists new, changed, and missing files; applying records the version; IM-7 newer wins', async () => {
    const open = await emptyBible('gd-check');
    const invoke = wire(open);
    // Without Drive, a check says so and changes nothing.
    await invoke('drive.link', { ids: ['x'] }).catch(() => undefined);
    expect((await invoke('drive.check', {})).connected).toBe(false);
    await connected(invoke);
    await invoke('drive.link', { ids: ['folderNovel', 'sheetLoose'] });

    const first = await invoke('drive.check', {});
    expect(first.files.map((f) => [f.name, f.state])).toEqual([
      ['Backstory.docx', 'new'],
      ['Chapter 3', 'new'],
      ['fixture-workbook', 'new'],
      ['Loose sheet', 'new'],
    ]);
    expect(first.summary).toBe(
      '4 linked Drive files: 4 not imported yet. Nothing changes until you review it.',
    );

    // Import the sheet once: it becomes unchanged.
    const imp = async (fileId: string) => {
      const { file } = await invoke('drive.open', { fileId });
      const plan = await invoke('import.plan', { fileId: file.id, mapping: people });
      return plan;
    };
    const plan1 = await imp('sheetWorld');
    await invoke('import.apply', { planId: plan1.planId, approved: plan1.items.map((i) => i.id) });
    const afterImport = await invoke('drive.check', {});
    expect(afterImport.files.find((f) => f.fileId === 'sheetWorld')!.state).toBe('unchanged');

    // Tommy edits the sheet in Drive: the check reports it, and the bible is untouched.
    fake.touch('sheetWorld', '2026-03-01T09:00:00.000Z', await editedWorkbook(1959));
    fake.files.get('wordBack')!.trashed = true;
    const before = JSON.stringify(open.repo.list('characters'));
    const second = await invoke('drive.check', {});
    expect(second.files.find((f) => f.fileId === 'sheetWorld')).toMatchObject({
      state: 'changed',
      seenModifiedTime: '2026-01-15T09:00:00.000Z',
      modifiedTime: '2026-03-01T09:00:00.000Z',
    });
    expect(second.files.find((f) => f.fileId === 'wordBack')).toBeUndefined();
    expect(second.summary).toContain('1 changed since you last imported');
    expect(JSON.stringify(open.repo.list('characters'))).toBe(before);

    // Reviewing shows the change as a comparison; nothing is written until approval.
    const plan2 = await imp('sheetWorld');
    const item = plan2.items.find((i) => i.title === 'Margaret Hale')!;
    expect(item.deltas.find((d) => d.path === 'birth')).toMatchObject({
      before: '1958',
      after: '1959',
      outcome: 'apply',
    });
    expect(JSON.stringify(open.repo.list('characters'))).toBe(before);
    const done = await invoke('import.apply', { planId: plan2.planId, approved: [item.id] });
    // IM-7: the newer Drive version wins and the disagreement becomes an open question.
    expect(done.questions).toBe(1);
    expect(open.repo.list('characters').find((c) => c.title === 'Margaret Hale')!.birth).toEqual({
      year: 1959,
    });
    expect(open.repo.list('openQuestions')[0]!.question).toContain(
      '(modified 2026-03-01) says 1959 [kept]',
    );
    expect(
      (await invoke('drive.check', {})).files.find((f) => f.fileId === 'sheetWorld')!.state,
    ).toBe('unchanged');
  });

  test('GD-3 a linked file that disappears is reported missing; mark as reviewed clears a change without importing', async () => {
    const open = await emptyBible('gd-missing');
    const invoke = wire(open);
    await connected(invoke);
    await invoke('drive.link', { ids: ['docCh3', 'sheetLoose'] });
    fake.files.delete('docCh3');
    const check = await invoke('drive.check', {});
    expect(check.files.map((f) => [f.name, f.state])).toEqual([
      ['Loose sheet', 'new'],
      ['Chapter 3', 'missing'],
    ]);
    await invoke('drive.markSeen', { fileId: 'sheetLoose' });
    expect(
      (await invoke('drive.check', {})).files.find((f) => f.fileId === 'sheetLoose')!.state,
    ).toBe('unchanged');
    expect(open.repo.list('characters')).toHaveLength(0);
  });
});

describe('GD-4 export to a Drive folder as Markdown by section and one JSON file', () => {
  test('GD-4 export asks for drive.file separately, writes only into folders the app created, and the JSON round-trips', async () => {
    const open = await openBibleSession(
      store,
      (await loadFixture(store, freshSlug('gd-export'))).id,
      {
        snapshotRoot: root,
      },
    );
    const invoke = wire(open);
    await connected(invoke);
    await expect(invoke('drive.exportFolders', {})).rejects.toThrow(/Allow export first/);
    const allowed = await invoke('drive.allowExport', {});
    expect(allowed.canExport).toBe(true);
    expect(fake.lastAuth!.get('scope')).toBe(`${READONLY} ${FILE}`);
    expect(fake.lastAuth!.get('include_granted_scopes')).toBe('true');

    // A folder the app did not create cannot be written to (drive.file).
    await expect(invoke('drive.export', { folderId: 'folderNovel' })).rejects.toThrow(
      /could not find/,
    );
    const { folder } = await invoke('drive.createExportFolder', {
      name: 'Novel Companion exports',
    });
    expect((await invoke('drive.exportFolders', {})).folders).toEqual([folder]);

    const out = await invoke('drive.export', { folderId: folder.id });
    const fixture = readFixture();
    const entryCount = Object.entries(fixture)
      .filter(([c]) => c !== 'lists')
      .reduce((n, [, docs]) => n + docs.filter((d) => !d.deletedAt).length, 0);
    expect(out.entries).toBe(entryCount);
    expect(out.files).toBe(entryCount + 1);
    const exportRoot = fake.files.get(out.folder.id)!;
    expect(exportRoot.parents).toEqual([folder.id]);
    expect(exportRoot.name).toMatch(/^Fixture novel \d{4}-\d\d-\d\d \d\d-\d\d-\d\dZ$/);

    // One Markdown file per entry, in a folder per section.
    const sectionFolders = [...fake.files.values()].filter((f) => f.parents[0] === out.folder.id);
    const names = sectionFolders.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['Characters', 'World events', 'Chapters']));
    const characters = sectionFolders.find((f) => f.name === 'Characters')!;
    const md = fake.uploads.filter((u) => u.parent === characters.id);
    expect(md).toHaveLength(fixture.characters!.length);
    const margaret = md.find((u) => u.name === 'Margaret Hale (H1).md')!;
    expect(margaret.mimeType).toBe('text/markdown');
    expect(margaret.content).toContain('# Margaret Hale');
    expect(margaret.content).toContain('- **Status**: ');
    expect(margaret.content).toContain('1958');

    // The JSON is the BK-3 export: it loads into an empty bible identically.
    const json = fake.uploads.find((u) => u.mimeType === 'application/json')!;
    expect(json.name).toBe(`${open.handle.id}.json`);
    const token = (JSON.parse(secrets.get(TOKENS_ACCOUNT)!) as { refreshToken: string })
      .refreshToken;
    expect(json.content).not.toContain(token);
    expect(json.content).not.toContain(fake.clientSecret);
    const copy = await createBible(store, freshSlug('gd-export-in'), 'From Drive');
    await importBibleJson(copy, json.content);
    const a = await dumpBible(open.handle);
    const b = await dumpBible(copy);
    for (const [name, docs] of Object.entries(a.collections)) {
      expect(b.collections[name], name).toEqual(docs);
    }
  });
});

describe('GD-5 disconnecting removes the tokens; the app works without Drive', () => {
  test('GD-5 disconnect revokes at Google and deletes the stored tokens; links stay, checks say not connected', async () => {
    const open = await emptyBible('gd-disconnect');
    const invoke = wire(open);
    await connected(invoke);
    await invoke('drive.link', { ids: ['sheetLoose'] });
    const refresh = (JSON.parse(secrets.get(TOKENS_ACCOUNT)!) as { refreshToken: string })
      .refreshToken;
    const status = await invoke('drive.disconnect', {});
    expect(status).toMatchObject({ connected: false, email: null, clientConfigured: true });
    expect(secrets.dump()[TOKENS_ACCOUNT]).toBeUndefined();
    expect(fake.revoked).toEqual([refresh]);
    await expect(invoke('drive.browse', {})).rejects.toThrow(/not connected/);
    const check = await invoke('drive.check', {});
    expect(check).toMatchObject({ connected: false, files: [] });
    // Import and editing go on as before.
    const local = ipcFor(() => open, { pickFile: async () => FIXTURE_WORKBOOK });
    const picked = await local('import.pickFile', { kind: 'workbook' });
    expect(picked.file?.name).toBe('fixture-workbook.xlsx');
    // Disconnecting with Google unreachable still deletes the tokens.
    await connected(invoke);
    await fake.close();
    expect((await invoke('drive.disconnect', {})).connected).toBe(false);
    expect(secrets.dump()[TOKENS_ACCOUNT]).toBeUndefined();
    fake = await startFakeGoogle();
  });

  test('GD-5 removing the client clears the client and the tokens', async () => {
    const invoke = wire(null);
    await connected(invoke);
    expect(await invoke('drive.clearClient', {})).toMatchObject({
      clientConfigured: false,
      connected: false,
    });
    expect(secrets.dump()).toEqual({});
  });
});

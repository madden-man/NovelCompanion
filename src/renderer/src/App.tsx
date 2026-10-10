import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { Response } from '../../shared/ipc';
import { BIBLE_SLUG_RULE, BibleSlug, slugify } from '../../shared/bible';

type BibleList = Response<'bible.list'>;
type Bible = Response<'bible.open'>['bible'];

/** Main's errors arrive wrapped by Electron; keep only the plain message. */
function plainError(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
}

export function App() {
  const [list, setList] = useState<BibleList | null>(null);
  const [current, setCurrent] = useState<Bible | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = () => {
      Promise.all([window.api.invoke('bible.list', {}), window.api.invoke('bible.current', {})])
        .then(([l, c]) => {
          if (!live) return;
          setList(l);
          setCurrent(c.bible);
        })
        .catch((e: unknown) => {
          if (live) setError(plainError(e));
        });
    };
    load();
    const off = window.api.on('bibles.changed', load);
    return () => {
      live = false;
      off();
    };
  }, []);

  const open = async (id: string) => {
    setError(null);
    try {
      const { bible } = await window.api.invoke('bible.open', { slug: id });
      setCurrent(bible);
    } catch (e) {
      setError(plainError(e));
    }
  };

  return (
    <main className="shell">
      <header className="stack">
        <h1>Novel Companion</h1>
        {current ? (
          <p className="lede">
            Open bible: <strong data-testid="current-bible">{current.name}</strong>
          </p>
        ) : (
          <p className="lede">Choose a bible to open, or make a new one.</p>
        )}
      </header>
      {error && (
        <p className="callout crit" role="alert">
          {error}
        </p>
      )}
      <section className="panel stack" aria-labelledby="bibles-heading">
        <h2 id="bibles-heading">Bibles</h2>
        <BibleSwitcher list={list} current={current} onOpen={open} />
      </section>
      {list?.connection === 'connected' && <NewBible onError={setError} />}
    </main>
  );
}

function BibleSwitcher(props: {
  list: BibleList | null;
  current: Bible | null;
  onOpen: (id: string) => Promise<void>;
}) {
  const { list, current, onOpen } = props;
  if (!list) return <p aria-live="polite">Loading bibles.</p>;
  return (
    <>
      {list.connection === 'unavailable' && list.message && (
        <p className="callout warn" role="status">
          {list.message}
        </p>
      )}
      {list.bibles.length === 0 ? (
        <p data-testid="no-bibles">No bibles yet</p>
      ) : (
        <ul className="bible-list" data-testid="bible-list">
          {list.bibles.map((b) => {
            const isOpen = current?.id === b.id;
            return (
              <li key={b.id} className="row">
                <span className="bible-name">{b.name}</span>
                <code className="id">{b.id}</code>
                <button
                  type="button"
                  className="btn small"
                  aria-pressed={isOpen}
                  disabled={isOpen}
                  onClick={() => void onOpen(b.id)}
                >
                  {isOpen ? 'Open now' : `Open ${b.name}`}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function NewBible({ onError }: { onError: (message: string | null) => void }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const shownSlug = slugEdited ? slug : slugify(name);
  const slugValid = BibleSlug.safeParse(shownSlug).success;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    onError(null);
    setBusy(true);
    try {
      await window.api.invoke('bible.create', { slug: shownSlug, name });
      setName('');
      setSlug('');
      setSlugEdited(false);
    } catch (err) {
      onError(plainError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel stack" aria-labelledby="new-bible-heading">
      <h2 id="new-bible-heading">New bible</h2>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <label className="field">
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="For example, East Winds"
            required
          />
        </label>
        <label className="field">
          ID
          <input
            value={shownSlug}
            onChange={(e) => {
              setSlugEdited(true);
              setSlug(e.target.value);
            }}
            aria-describedby="slug-rule"
            aria-invalid={shownSlug !== '' && !slugValid}
          />
        </label>
        <p id="slug-rule" className="example-note">
          The ID names the bible in the database. {BIBLE_SLUG_RULE}
        </p>
        <div className="row">
          <button
            type="submit"
            className="btn primary"
            disabled={busy || !name.trim() || !slugValid}
          >
            Create bible
          </button>
        </div>
      </form>
    </section>
  );
}

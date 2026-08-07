import { useEffect, useRef, useState, useId } from 'react';
import { Icon } from '@components/core/Icon';
import { useLabelSuggestions } from '@hooks/useLabelSuggestions';
import './QueryBar.css';

// Query input row with a Run button. While editing inside the `{...}`
// selector a fuzzy typeahead popup suggests label names and, after an
// operator, label values.
export function QueryBar({
  query,
  onQueryChange,
  onRun,
  start,
  end,
  tenantID,
  loading = false,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  onRun: (query: string) => void;
  start: number;
  end: number;
  tenantID?: string;
  /** Shows a spinner on the Run button while the query is in flight. */
  loading?: boolean;
}) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [caret, setCaret] = useState(query.length);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);

  const { suggestions, apply } = useLabelSuggestions({
    text: query,
    caret,
    start,
    end,
    tenantID,
    enabled: open,
  });
  const showing = open && suggestions.length > 0;
  const active = Math.min(activeIdx, Math.max(suggestions.length - 1, 0));

  useEffect(() => {
    if (!showing) return;
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [showing, active]);

  const accept = (item: string) => {
    const next = apply(item);
    onQueryChange(next.value);
    setCaret(next.caret);
    setActiveIdx(0);
    const input = inputRef.current;
    if (input) {
      input.focus();
      requestAnimationFrame(() => {
        input.setSelectionRange(next.caret, next.caret);
      });
    }
  };

  const run = () => {
    setOpen(false);
    onRun(query);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && showing) {
      e.preventDefault();
      setActiveIdx((active + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp' && showing) {
      e.preventDefault();
      setActiveIdx((active - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (showing) accept(suggestions[active]);
      else run();
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className="querybar">
      <div className="querybar-input-wrap">
        <input
          ref={inputRef}
          className="querybar-input"
          type="text"
          role="combobox"
          aria-expanded={showing}
          aria-controls={listId}
          aria-activedescendant={
            showing ? `${listId}-opt-${active}` : undefined
          }
          aria-autocomplete="list"
          value={query}
          placeholder='{service_name="my-service", profile_type="..."}'
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            onQueryChange(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setActiveIdx(0);
            setOpen(true);
          }}
          onSelect={(e) => {
            setCaret(
              e.currentTarget.selectionStart ?? e.currentTarget.value.length,
            );
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setOpen(false)}
        />
        {showing && (
          <ul
            className="querybar-suggestions"
            id={listId}
            ref={listRef}
            role="listbox"
          >
            {suggestions.map((item, i) => (
              <li
                key={item}
                id={`${listId}-opt-${i}`}
                role="option"
                aria-selected={i === active}
                className={`querybar-suggestion${i === active ? ' active' : ''}`}
                // mousedown (not click) so the input never loses focus
                onMouseDown={(e) => {
                  e.preventDefault();
                  accept(item);
                }}
                onMouseMove={() => setActiveIdx(i)}
              >
                {item}
              </li>
            ))}
          </ul>
        )}
      </div>
      <button
        type="button"
        className="querybar-run"
        onClick={run}
        disabled={loading}
        aria-busy={loading}
      >
        <Icon
          name={loading ? 'refresh' : 'play'}
          size={14}
          className={loading ? 'querybar-spin' : undefined}
        />
        Run
      </button>
    </div>
  );
}

import { useEffect, useRef, useState, useId } from 'react';
import { Icon } from '@components/core/Icon';
import { useLabelSuggestions } from '@hooks/useLabelSuggestions';
import './QueryBar.css';

// The Run control itself, factored out so DiffView's single global Run
// (one joint fetch over both panes, so per-pane Run buttons there are
// hidden — see the `hideRunButton` prop below) renders with the exact same
// markup/styling instead of a hand-copied button. A control's busy state is
// a calm indicator like the panel metas', not a chart visual — callers pass
// the full `loading` value, never the tick-suppressed one (urlState.ts's
// useTickNavigation doctrine is about chart visuals only).
export function RunButton({
  loading = false,
  onClick,
}: {
  loading?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="querybar-run"
      onClick={onClick}
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
  );
}

// Query input row with a Run button. While editing inside the `{...}`
// selector a fuzzy typeahead popup suggests label names and, after an
// operator, label values.
export function QueryBar({
  query,
  committedQuery,
  onQueryChange,
  onRun,
  start,
  end,
  tenantID,
  loading = false,
  hideRunButton = false,
}: {
  /** The draft being edited (an edit buffer over `committedQuery`). */
  query: string;
  /** The query as the URL holds it; a change re-anchors the typeahead. */
  committedQuery: string;
  onQueryChange: (query: string) => void;
  onRun: (query: string) => void;
  start: number;
  end: number;
  tenantID?: string;
  /** Shows a spinner on the Run button while the query is in flight. */
  loading?: boolean;
  /**
   * Hides this bar's own Run button while leaving Enter's commit-this-pane
   * behavior untouched — Diff's per-pane query bars use this: the diff
   * flame graph is one joint query over both panes, so a per-pane Run there
   * would misleadingly suggest it alone refreshes anything. DiffView renders
   * one global Run (RunButton, above) instead.
   */
  hideRunButton?: boolean;
}) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [caret, setCaret] = useState(query.length);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);

  // The caret offset and the open popup belong to the text the user was
  // editing. When the URL moves underneath — Back, a link, or App writing
  // the default query in once the service list lands — useEditBuffer drops
  // the draft and that text is gone, so a caret into it now points at
  // something else and accepting a suggestion would splice into the wrong
  // place. Reset during render, the same rule the edit buffer itself uses.
  const [prevCommitted, setPrevCommitted] = useState(committedQuery);
  if (prevCommitted !== committedQuery) {
    setPrevCommitted(committedQuery);
    setCaret(query.length);
    setOpen(false);
    setActiveIdx(0);
  }

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
          aria-label="Query selector"
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
      {!hideRunButton && <RunButton loading={loading} onClick={run} />}
    </div>
  );
}

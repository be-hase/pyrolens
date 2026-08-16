import uFuzzy from '@leeoniya/ufuzzy';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from './Button';
import { Dropdown } from './Dropdown';
import { Icon } from './Icon';
import './CascadeSelect.css';

export interface CascadeItem {
  label: string;
  value: string;
}

export interface CascadeGroup {
  label: string;
  value: string;
  items: CascadeItem[];
}

const uf = new uFuzzy();

// Fuzzy-orders groups by label against the typed filter, following the same
// filter/info/sort idiom as useLabelSuggestions so a non-prefix match (e.g.
// "out" for "checkout-service") still surfaces, and in ufuzzy's own ranked
// order rather than source order. Empty needle keeps the original order.
function filterGroups(groups: CascadeGroup[], needle: string): CascadeGroup[] {
  if (!needle) return groups;
  const labels = groups.map((g) => g.label);
  const idxs = uf.filter(labels, needle);
  if (!idxs || idxs.length === 0) return [];
  const info = uf.info(idxs, labels, needle);
  const order = uf.sort(info, labels, needle);
  return order.map((i) => groups[info.idx[i]]);
}

// Two-level picker (service -> profile type). The trigger shows
// "<group> · <item>"; the popup is two columns: groups on the left, the
// highlighted group's items on the right. The left column also has a filter
// input with basic keyboard navigation; the right column stays mouse-driven.
export function CascadeSelect({
  groups,
  groupLabel,
  itemLabel,
  value,
  onChange,
  loading = false,
}: {
  groups: CascadeGroup[];
  groupLabel: string;
  itemLabel: string;
  value: { group: string; item: string };
  onChange: (group: string, item: string) => void;
  loading?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Group whose items are listed in the right column; null = follow the
  // current selection. Reset on every open.
  const [browsed, setBrowsed] = useState<string | null>(null);
  // The left column's filter text and keyboard highlight. Both are
  // transient — they only narrow which URL-backed group gets picked — so
  // they reset whenever the dropdown opens or closes rather than surviving
  // underneath the next visit.
  const [filter, setFilter] = useState('');
  // The highlighted group's *value*, not its position in `filteredGroups`:
  // an index drifts the moment the list reorders underneath it (a refetch
  // while open, or the filter changing), landing Enter on whatever entry
  // inherited that slot rather than the row the user actually arrowed to.
  const [highlight, setHighlight] = useState<string | null>(null);

  const resetTransient = () => {
    setBrowsed(null);
    setFilter('');
    setHighlight(null);
  };

  const filteredGroups = useMemo(
    () => filterGroups(groups, filter),
    [groups, filter],
  );
  // -1 when nothing is highlighted, or the highlighted value has been
  // filtered out from underneath it — both cases arrows treat as "no
  // position yet" rather than resolving to a stale row.
  const highlightedIndex =
    highlight === null
      ? -1
      : filteredGroups.findIndex((g) => g.value === highlight);

  const selectedGroup = groups.find((g) => g.value === value.group);
  const selectedItem = selectedGroup?.items.find((i) => i.value === value.item);
  // Derived from the FILTERED set only: browsing a group and then typing a
  // filter that excludes it must not go on showing (or letting a click
  // select) items for a group no longer listed on the left. The simpler of
  // the two consistent options — show nothing rather than falling back to
  // the first filtered match — since a silent fallback would let Enter/click
  // commit a group the user never chose.
  const shownGroup =
    filteredGroups.find((g) => g.value === (browsed ?? value.group)) ?? null;

  // Scrolls the highlighted row into view when it moves off the fold. Only
  // the left column needs this — the right column is mouse-driven (see the
  // component doc comment above).
  const groupListRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (highlightedIndex < 0) return;
    groupListRef.current?.children[highlightedIndex]?.scrollIntoView({
      block: 'nearest',
    });
  }, [highlightedIndex]);

  const triggerText = loading
    ? 'Loading…'
    : !selectedGroup
      ? `Select ${groupLabel.toLowerCase()}`
      : selectedItem
        ? `${selectedGroup.label} · ${selectedItem.label}`
        : selectedGroup.label;

  // Enter picks the highlighted row, or — with the filter narrowed to a
  // single match — that one match even though nothing was arrowed to.
  const onFilterKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      if (filteredGroups.length === 0) return;
      e.preventDefault();
      // No position yet (-1) advances to the first row like any other step.
      const next = (highlightedIndex + 1) % filteredGroups.length;
      setHighlight(filteredGroups[next].value);
    } else if (e.key === 'ArrowUp') {
      if (filteredGroups.length === 0) return;
      e.preventDefault();
      // No position yet starts from the *last* row, not one step before it —
      // `(-1 - 1 + N) % N` lands on N-2, skipping the last row entirely.
      const prev =
        highlightedIndex < 0
          ? filteredGroups.length - 1
          : (highlightedIndex - 1 + filteredGroups.length) %
            filteredGroups.length;
      setHighlight(filteredGroups[prev].value);
    } else if (e.key === 'Enter') {
      const target =
        highlightedIndex >= 0
          ? filteredGroups[highlightedIndex]
          : filteredGroups.length === 1
            ? filteredGroups[0]
            : null;
      if (target) {
        e.preventDefault();
        setBrowsed(target.value);
      }
    }
  };

  return (
    <div className="cascade-select">
      <Button
        iconRight="angle-down"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          resetTransient();
          setOpen((o) => !o);
        }}
      >
        {triggerText}
      </Button>
      <Dropdown
        open={open}
        onClose={() => {
          setOpen(false);
          resetTransient();
        }}
        className="cascade-menu"
      >
        <div className="cascade-col">
          <div className="cascade-col-title">{groupLabel}</div>
          <input
            type="text"
            className="cascade-filter"
            aria-label={`Filter ${groupLabel.toLowerCase()}`}
            placeholder={`Filter ${groupLabel.toLowerCase()}…`}
            autoFocus
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setHighlight(null);
            }}
            onKeyDown={onFilterKeyDown}
          />
          <div className="cascade-col-list" ref={groupListRef}>
            {filteredGroups.length === 0 ? (
              <div className="cascade-empty">
                {/* Stale data can outlive the start of a refetch (loading
                    true, groups still non-empty from before); a filter that
                    narrows that stale set to nothing must still say
                    something instead of leaving the list blank. */}
                {loading ? 'Loading…' : 'No results'}
              </div>
            ) : (
              filteredGroups.map((g) => (
                <button
                  type="button"
                  key={g.value}
                  className={[
                    'cascade-option',
                    g.value === shownGroup?.value && 'active',
                    g.value === highlight && 'highlighted',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => {
                    setBrowsed(g.value);
                    setHighlight(g.value);
                  }}
                >
                  <span className="cascade-option-label">{g.label}</span>
                  <Icon name="angle-right" size={12} />
                </button>
              ))
            )}
          </div>
        </div>
        <div className="cascade-col">
          <div className="cascade-col-title">{itemLabel}</div>
          <div className="cascade-col-list">
            {!shownGroup || shownGroup.items.length === 0 ? (
              <div className="cascade-empty">
                {shownGroup
                  ? 'No results'
                  : `Select ${groupLabel.toLowerCase()}`}
              </div>
            ) : (
              shownGroup.items.map((i) => (
                <button
                  type="button"
                  key={i.value}
                  className={
                    shownGroup.value === value.group && i.value === value.item
                      ? 'cascade-option active'
                      : 'cascade-option'
                  }
                  onClick={() => {
                    setOpen(false);
                    onChange(shownGroup.value, i.value);
                  }}
                >
                  <span className="cascade-option-label">{i.label}</span>
                </button>
              ))
            )}
          </div>
        </div>
      </Dropdown>
    </div>
  );
}

import { useState } from 'react';
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

// Two-level picker (service -> profile type). The trigger shows
// "<group> · <item>"; the popup is two columns: groups on the left, the
// highlighted group's items on the right.
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

  const selectedGroup = groups.find((g) => g.value === value.group);
  const selectedItem = selectedGroup?.items.find((i) => i.value === value.item);
  const shownGroup =
    groups.find((g) => g.value === (browsed ?? value.group)) ?? null;

  const triggerText = loading
    ? 'Loading…'
    : !selectedGroup
      ? `Select ${groupLabel.toLowerCase()}`
      : selectedItem
        ? `${selectedGroup.label} · ${selectedItem.label}`
        : selectedGroup.label;

  return (
    <div className="cascade-select">
      <Button
        iconRight="angle-down"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setBrowsed(null);
          setOpen((o) => !o);
        }}
      >
        {triggerText}
      </Button>
      <Dropdown
        open={open}
        onClose={() => setOpen(false)}
        className="cascade-menu"
      >
        <div className="cascade-col">
          <div className="cascade-col-title">{groupLabel}</div>
          <div className="cascade-col-list">
            {groups.length === 0 && (
              <div className="cascade-empty">
                {loading ? 'Loading…' : 'No results'}
              </div>
            )}
            {groups.map((g) => (
              <button
                type="button"
                key={g.value}
                className={
                  g.value === shownGroup?.value
                    ? 'cascade-option active'
                    : 'cascade-option'
                }
                onClick={() => setBrowsed(g.value)}
              >
                <span className="cascade-option-label">{g.label}</span>
                <Icon name="angle-right" size={12} />
              </button>
            ))}
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

import { Icon } from '@components/core/Icon';
import { Select } from '@components/core/Select';
import { buildUrl, onLinkClick } from '../urlState';
import './NavBar.css';

const TABS = [
  { id: 'single', label: 'Single', path: '/' },
  { id: 'comparison', label: 'Comparison', path: '/comparison' },
  { id: 'diff', label: 'Diff', path: '/diff' },
  { id: 'explore', label: 'Tag Explorer', path: '/explore' },
];

const THEME_OPTIONS = [
  { label: 'Dark', value: 'dark' },
  { label: 'Light', value: 'light' },
];

export function NavBar({
  activeView,
  theme,
  onThemeChange,
  tenantID,
  onChangeTenant,
}: {
  activeView: string;
  theme: 'dark' | 'light';
  onThemeChange: (theme: 'dark' | 'light') => void;
  tenantID?: string;
  onChangeTenant?: () => void;
}) {
  return (
    <nav className="navbar">
      <div className="navbar-brand">
        <Icon name="logo" size={18} />
        <span className="navbar-brand-name">Pyrolens</span>
      </div>
      <div className="navbar-divider" />
      <div className="navbar-tabs">
        {TABS.map((tab) => (
          <a
            key={tab.id}
            className={`navbar-tab${tab.id === activeView ? ' active' : ''}`}
            href={buildUrl({ path: tab.path })}
            onClick={onLinkClick({ path: tab.path })}
          >
            {tab.label}
          </a>
        ))}
      </div>
      <div className="navbar-spacer" />
      {tenantID !== undefined && (
        <button
          type="button"
          className="navbar-tenant"
          title="Change tenant"
          onClick={onChangeTenant}
        >
          {tenantID}
        </button>
      )}
      <Select
        value={theme}
        options={THEME_OPTIONS}
        align="right"
        onChange={(v) => onThemeChange(v === 'light' ? 'light' : 'dark')}
      />
    </nav>
  );
}

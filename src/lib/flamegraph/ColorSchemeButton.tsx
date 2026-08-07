import { cx } from './cx';
import {
  byPackageGradient,
  byValueGradient,
  diffColorBlindGradient,
  diffDefaultGradient,
} from './FlameGraph/colors';
import { ColorScheme, ColorSchemeDiff } from './types';
import { Button } from './ui/Button';
import { Dropdown } from './ui/Dropdown';
import { Menu, MenuItem } from './ui/Menu';
import './ColorSchemeButton.css';

type ColorSchemeButtonProps = {
  value: ColorScheme | ColorSchemeDiff;
  onChange: (colorScheme: ColorScheme | ColorSchemeDiff) => void;
  isDiffMode: boolean;
};

export function ColorSchemeButton(props: ColorSchemeButtonProps) {
  let menu = (
    <Menu>
      <MenuItem
        label="By package name"
        onClick={() => props.onChange(ColorScheme.PackageBased)}
      />
      <MenuItem
        label="By value"
        onClick={() => props.onChange(ColorScheme.ValueBased)}
      />
    </Menu>
  );

  // Show a bit different gradient as a way to indicate selected value.
  const gradient =
    {
      [ColorScheme.ValueBased]: byValueGradient,
      [ColorScheme.PackageBased]: byPackageGradient,
      [ColorSchemeDiff.DiffColorBlind]: diffColorBlindGradient,
      [ColorSchemeDiff.Default]: diffDefaultGradient,
    }[props.value] || byValueGradient;

  let contents = (
    <span className="plfg-color-dot" style={{ background: gradient }} />
  );

  if (props.isDiffMode) {
    menu = (
      <Menu>
        <MenuItem
          label="Default (green to red)"
          onClick={() => props.onChange(ColorSchemeDiff.Default)}
        />
        <MenuItem
          label="Color blind (blue to red)"
          onClick={() => props.onChange(ColorSchemeDiff.DiffColorBlind)}
        />
      </Menu>
    );

    contents = (
      <div className="plfg-color-dot-diff" style={{ background: gradient }}>
        <div>-100% (removed)</div>
        <div>0%</div>
        <div>+100% (added)</div>
      </div>
    );
  }

  return (
    <Dropdown overlay={menu}>
      <Button
        variant="secondary"
        size="sm"
        title="Change color scheme"
        onClick={() => {}}
        className={cx(
          'plfg-color-scheme-button',
          props.isDiffMode && 'plfg-color-scheme-button-diff',
        )}
        aria-label="Change color scheme"
      >
        {contents}
      </Button>
    </Dropdown>
  );
}

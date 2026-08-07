import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react';

import { ColorSchemeButton } from './ColorSchemeButton';
import { type CollapsedMap } from './FlameGraph/dataTransform';
import { MIN_WIDTH_TO_SHOW_BOTH_TOPTABLE_AND_FLAMEGRAPH } from './constants';
import { cx } from './cx';
import {
  type ColorScheme,
  type ColorSchemeDiff,
  SelectedView,
  type TextAlign,
} from './types';
import { Button } from './ui/Button';
import { ButtonGroup } from './ui/ButtonGroup';
import { Input } from './ui/Input';
import { RadioButtonGroup, type RadioOption } from './ui/RadioButtonGroup';
import './FlameGraphHeader.css';
import { usePrevious } from './hooks';

type Props = {
  search: string;
  setSearch: (search: string) => void;
  selectedView: SelectedView;
  setSelectedView: (view: SelectedView) => void;
  containerWidth: number;
  onReset: () => void;
  textAlign: TextAlign;
  onTextAlignChange: (align: TextAlign) => void;
  showResetButton: boolean;
  colorScheme: ColorScheme | ColorSchemeDiff;
  onColorSchemeChange: (colorScheme: ColorScheme | ColorSchemeDiff) => void;
  stickyHeader: boolean;
  vertical?: boolean;
  isDiffMode: boolean;
  setCollapsedMap: (collapsedMap: CollapsedMap) => void;
  collapsedMap: CollapsedMap;

  extraHeaderElements?: ReactNode;
};

const FlameGraphHeader = ({
  search,
  setSearch,
  selectedView,
  setSelectedView,
  containerWidth,
  onReset,
  textAlign,
  onTextAlignChange,
  showResetButton,
  colorScheme,
  onColorSchemeChange,
  stickyHeader,
  vertical,
  isDiffMode,
  setCollapsedMap,
  collapsedMap,
  extraHeaderElements,
}: Props) => {
  const [localSearch, setLocalSearch] = useSearchInput(search, setSearch);

  // Collapsing/aligning only makes sense while the flame graph is visible.
  const graphControlsDisabled = selectedView === SelectedView.TopTable;

  const suffix =
    localSearch !== '' ? (
      <Button
        icon="times"
        size="sm"
        variant="secondary"
        className="plfg-header-clear"
        aria-label="Clear search"
        onClick={() => {
          // We could set only one and wait them to sync but there is no need to
          // debounce this.
          setSearch('');
          setLocalSearch('');
        }}
      >
        Clear
      </Button>
    ) : null;

  return (
    <div className={cx('plfg-header', stickyHeader && 'plfg-header-sticky')}>
      <div className="plfg-header-input">
        <Input
          value={localSearch || ''}
          onChange={(v: ChangeEvent<HTMLInputElement>) => {
            setLocalSearch(v.currentTarget.value);
          }}
          placeholder="Search..."
          aria-label="Search"
          suffix={suffix}
        />
      </div>

      <div className="plfg-header-right">
        {showResetButton && (
          <Button
            variant="secondary"
            size="sm"
            icon="history-alt"
            title="Reset focus and sandwich state"
            aria-label="Reset focus and sandwich state"
            className="plfg-button-spacing"
            onClick={() => {
              onReset();
            }}
          />
        )}

        <ColorSchemeButton
          value={colorScheme}
          onChange={onColorSchemeChange}
          isDiffMode={isDiffMode}
        />

        <ButtonGroup className="plfg-button-spacing">
          <Button
            variant="secondary"
            size="sm"
            icon="angle-double-down"
            title="Expand all groups"
            aria-label="Expand all groups"
            disabled={graphControlsDisabled}
            onClick={() => {
              setCollapsedMap(collapsedMap.setAllCollapsedStatus(false));
            }}
          />
          <Button
            variant="secondary"
            size="sm"
            icon="angle-double-up"
            title="Collapse all groups"
            aria-label="Collapse all groups"
            disabled={graphControlsDisabled}
            onClick={() => {
              setCollapsedMap(collapsedMap.setAllCollapsedStatus(true));
            }}
          />
        </ButtonGroup>

        <RadioButtonGroup<TextAlign>
          size="sm"
          disabled={graphControlsDisabled}
          options={alignOptions}
          value={textAlign}
          onChange={onTextAlignChange}
          className="plfg-button-spacing"
        />

        <RadioButtonGroup<SelectedView>
          size="sm"
          options={getViewOptions(containerWidth, vertical)}
          value={selectedView}
          onChange={setSelectedView}
        />

        {extraHeaderElements && (
          <div className="plfg-header-extra">{extraHeaderElements}</div>
        )}
      </div>
    </div>
  );
};

export const alignOptions: Array<RadioOption<TextAlign>> = [
  { value: 'left', description: 'Align text left', icon: 'align-left' },
  { value: 'right', description: 'Align text right', icon: 'align-right' },
];

function getViewOptions(
  width: number,
  vertical?: boolean,
): Array<RadioOption<SelectedView>> {
  const viewOptions: Array<RadioOption<SelectedView>> = [
    {
      value: SelectedView.TopTable,
      label: 'Top Table',
      description: 'Only show top table',
    },
    {
      value: SelectedView.FlameGraph,
      label: 'Flame Graph',
      description: 'Only show flame graph',
    },
  ];

  if (width >= MIN_WIDTH_TO_SHOW_BOTH_TOPTABLE_AND_FLAMEGRAPH || vertical) {
    viewOptions.push({
      value: SelectedView.Both,
      label: 'Both',
      description: 'Show both the top table and flame graph',
    });
  }

  return viewOptions;
}

/**
 * Keeps a local, immediately responsive value for the search input while
 * debouncing the propagation to the parent (changing the parent search
 * rerenders both the flame graph and the table).
 */
function useSearchInput(
  search: string,
  setSearch: (search: string) => void,
): [string | undefined, (search: string) => void] {
  const [localSearchState, setLocalSearchState] = useState(search);
  const prevSearch = usePrevious(search);

  // Keep the latest setter in a ref so the debounce timer only restarts when
  // the local value actually changes.
  const setSearchRef = useRef(setSearch);
  setSearchRef.current = setSearch;

  useEffect(() => {
    const timeout = setTimeout(() => {
      setSearchRef.current(localSearchState);
    }, 250);
    return () => clearTimeout(timeout);
  }, [localSearchState]);

  // Make sure we still handle updates from parent (from clicking on a table
  // item for example). We check if the parent search value changed to something
  // that isn't our local value.
  useEffect(() => {
    if (prevSearch !== search && search !== localSearchState) {
      setLocalSearchState(search);
    }
  }, [search, prevSearch, localSearchState]);

  return [localSearchState, setLocalSearchState];
}

export default FlameGraphHeader;

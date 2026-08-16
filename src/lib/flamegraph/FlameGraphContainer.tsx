import uFuzzy from '@leeoniya/ufuzzy';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import FlameGraph from './FlameGraph/FlameGraph';
import { type GetExtraContextMenuButtonsFunction } from './FlameGraph/FlameGraphContextMenu';
import {
  CollapsedMap,
  FlameGraphDataContainer,
} from './FlameGraph/dataTransform';
import FlameGraphHeader from './FlameGraphHeader';
import FlameGraphTopTableContainer from './TopTable/FlameGraphTopTableContainer';
import { MIN_WIDTH_TO_SHOW_BOTH_TOPTABLE_AND_FLAMEGRAPH } from './constants';
import { type DataFrame } from './data';
import { useColorScheme } from './hooks';
import { useTheme } from './theme';
import { type ClickedItemData, SelectedView, type TextAlign } from './types';
import { escapeStringForRegex } from './utils';
import './FlameGraphContainer.css';
import { useMeasure } from './hooks';

const ufuzzy = new uFuzzy();

export type Props = {
  /**
   * DataFrame with the profile data. The dataFrame needs to have the following fields:
   * label: string - the label of the node
   * level: number - the nesting level of the node
   * value: number - the total value of the node
   * self: number - the self value of the node
   * Optionally if it represents diff of 2 different profiles it can also have fields:
   * valueRight: number - the total value of the node in the right profile
   * selfRight: number - the self value of the node in the right profile
   */
  data?: DataFrame;

  /**
   * Whether the header should be sticky and be always visible on the top when scrolling.
   */
  stickyHeader?: boolean;

  /**
   * Various interaction hooks that can be used to report on the interaction.
   */
  onTableSymbolClick?: (symbol: string) => void;
  onViewSelected?: (view: string) => void;
  onTextAlignSelected?: (align: string) => void;
  onTableSort?: (sort: string) => void;

  /**
   * Elements that will be shown in the header on the right side of the header buttons. Useful for additional
   * functionality.
   */
  extraHeaderElements?: ReactNode;

  /**
   * Extra buttons that will be shown in the context menu when user clicks on a Node.
   */
  getExtraContextMenuButtons?: GetExtraContextMenuButtonsFunction;

  /**
   * If true the flamegraph will be rendered on top of the table.
   */
  vertical?: boolean;

  /**
   * If true only the flamegraph will be rendered.
   */
  showFlameGraphOnly?: boolean;

  /**
   * Disable behaviour where similar items in the same stack will be collapsed into single item.
   */
  disableCollapsing?: boolean;

  /**
   * Whether or not to keep any focused item when the profile data changes.
   */
  keepFocusOnDataChange?: boolean;

  /**
   * Controlled search text. When provided (together with onSearchChange),
   * the component reads/writes this instead of its own internal state — see
   * VENDORED.md's local-fixes section.
   */
  search?: string;
  onSearchChange?: (search: string) => void;

  /**
   * Controlled sandwich selection. When onSandwichChange is provided, the
   * component reads/writes this instead of its own internal state — see
   * VENDORED.md's local-fixes section.
   */
  sandwichItem?: string | undefined;
  onSandwichChange?: (item: string | undefined) => void;
};

const FlameGraphContainer = ({
  data,
  onTableSymbolClick,
  onViewSelected,
  onTextAlignSelected,
  onTableSort,
  stickyHeader,
  extraHeaderElements,
  vertical,
  showFlameGraphOnly,
  disableCollapsing,
  keepFocusOnDataChange,
  getExtraContextMenuButtons,
  search: controlledSearch,
  onSearchChange,
  sandwichItem: controlledSandwichItem,
  onSandwichChange,
}: Props) => {
  const theme = useTheme();

  const [focusedItemData, setFocusedItemData] = useState<ClickedItemData>();

  const [rangeMin, setRangeMin] = useState(0);
  const [rangeMax, setRangeMax] = useState(1);
  const [internalSearch, setInternalSearch] = useState('');
  const search = controlledSearch ?? internalSearch;
  const setSearch = useCallback(
    (value: string) => {
      onSearchChange?.(value);
      if (controlledSearch === undefined) {
        setInternalSearch(value);
      }
    },
    [controlledSearch, onSearchChange],
  );
  const [selectedView, setSelectedView] = useState<SelectedView>(
    SelectedView.Both,
  );
  const [sizeRef, { width: containerWidth }] = useMeasure<HTMLDivElement>();
  const [textAlign, setTextAlign] = useState<TextAlign>('left');
  // This is a label of the item because in sandwich view we group all items by label and present a merged graph
  const [internalSandwichItem, setInternalSandwichItem] = useState<string>();
  // A defined controlled value can legitimately be `undefined` (no
  // sandwich), so unlike `search` this can't tell controlled from
  // uncontrolled by nullishness alone — the presence of the change handler
  // is the signal instead.
  const sandwichItem = onSandwichChange
    ? controlledSandwichItem
    : internalSandwichItem;
  const setSandwichItem = useCallback(
    (item: string | undefined) => {
      onSandwichChange?.(item);
      if (!onSandwichChange) {
        setInternalSandwichItem(item);
      }
    },
    [onSandwichChange],
  );
  // Reset focus/zoom whenever the *resolved* sandwich value changes, no
  // matter whether the change came from this pane's own onSandwich click or
  // arrived via a controlled prop set by the other Comparison pane through
  // the URL: a controlled sandwich change previously left the old
  // rangeMin/rangeMax/focusedItemData in place, so the pane rendered a
  // clipped/zoomed view with a stale focus pill against the new sandwich.
  // Comparing during render (useEditBuffer's idiom, see AGENTS.md) lands the
  // reset in the same commit as the sandwich change rather than one render
  // later. onSandwich below no longer calls resetFocus itself, or a
  // locally-triggered change would reset twice.
  const [previousSandwichItem, setPreviousSandwichItem] =
    useState(sandwichItem);
  if (previousSandwichItem !== sandwichItem) {
    setPreviousSandwichItem(sandwichItem);
    setFocusedItemData(undefined);
    setRangeMin(0);
    setRangeMax(1);
  }
  const [collapsedMap, setCollapsedMap] = useState(new CollapsedMap());

  // Use refs to hold the latest callback values to prevent unnecessary re-renders
  const onTableSymbolClickRef = useRef(onTableSymbolClick);
  const onTableSortRef = useRef(onTableSort);

  // Update refs when props change
  onTableSymbolClickRef.current = onTableSymbolClick;
  onTableSortRef.current = onTableSort;

  const dataContainer = useMemo((): FlameGraphDataContainer | undefined => {
    if (!data) {
      return;
    }

    const container = new FlameGraphDataContainer(
      data,
      { collapsing: !disableCollapsing },
      theme,
    );
    setCollapsedMap(container.getCollapsedMap());
    return container;
    // `theme` is deliberately not a dependency. It reaches the container only
    // as an argument to getDisplayProcessor, and this project's format.ts
    // ignores it — so a theme flip produced a new container that changed
    // nothing, which reset the collapsed map here and tripped the
    // reset-on-data-change effect below into throwing away the user's zoom
    // and sandwich view. Changing a colour must not move the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, disableCollapsing]);
  const [colorScheme, setColorScheme] = useColorScheme(dataContainer);
  const matchedLabels = useLabelSearch(search, dataContainer);

  // If user resizes window with both as the selected view
  useEffect(() => {
    if (
      containerWidth > 0 &&
      containerWidth < MIN_WIDTH_TO_SHOW_BOTH_TOPTABLE_AND_FLAMEGRAPH &&
      selectedView === SelectedView.Both &&
      !vertical
    ) {
      setSelectedView(SelectedView.FlameGraph);
    }
  }, [selectedView, setSelectedView, containerWidth, vertical]);

  const resetFocus = useCallback(() => {
    setFocusedItemData(undefined);
    setRangeMin(0);
    setRangeMax(1);
  }, [setFocusedItemData, setRangeMax, setRangeMin]);

  const resetSandwich = useCallback(() => {
    setSandwichItem(undefined);
  }, [setSandwichItem]);

  useEffect(() => {
    if (!keepFocusOnDataChange) {
      resetFocus();
      // A controlled sandwich selection is round-tripped through the URL by
      // the caller, not a coordinate scoped to this data load — clearing it
      // here on every refresh would undo a deep link the moment the profile
      // finished loading. Only the internal, uncontrolled sandwich resets
      // automatically; a controlled one is cleared by the caller (Reset,
      // toggling the same item off) same as it is set.
      if (!onSandwichChange) {
        resetSandwich();
      }
      return;
    }

    if (dataContainer && focusedItemData) {
      const item = dataContainer.getNodesWithLabel(focusedItemData.label)?.[0];

      if (item) {
        setFocusedItemData({ ...focusedItemData, item });

        const levels = dataContainer.getLevels();
        const totalViewTicks = levels.length ? levels[0][0].value : 0;
        setRangeMin(item.start / totalViewTicks);
        setRangeMax((item.start + item.value) / totalViewTicks);
      } else {
        setFocusedItemData({
          ...focusedItemData,
          item: {
            start: 0,
            value: 0,
            itemIndexes: [],
            children: [],
            level: 0,
          },
        });

        setRangeMin(0);
        setRangeMax(1);
      }
    }
  }, [dataContainer, keepFocusOnDataChange]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSymbolClick = useCallback(
    (symbol: string) => {
      const anchored = `^${escapeStringForRegex(symbol)}$`;

      if (search === anchored) {
        setSearch('');
      } else {
        onTableSymbolClickRef.current?.(symbol);
        setSearch(anchored);
        resetFocus();
      }
    },
    [setSearch, resetFocus, search],
  );

  // Memoize methods to prevent unnecessary re-renders of FlameGraphTopTableContainer
  const onSearch = useCallback(
    (str: string) => {
      if (!str) {
        setSearch('');
        return;
      }
      setSearch(`^${escapeStringForRegex(str)}$`);
    },
    [setSearch],
  );
  const onSandwich = useCallback(
    (label: string) => {
      // Focus/zoom resets from the render-time check above (it fires for
      // any resolved sandwichItem change, this click included) — calling
      // resetFocus here too would just be a redundant extra reset.
      setSandwichItem(label);
    },
    [setSandwichItem],
  );
  const onTableSortStable = useCallback((sort: string) => {
    onTableSortRef.current?.(sort);
  }, []);

  if (!dataContainer) {
    return null;
  }

  const flameGraph = (
    <FlameGraph
      data={dataContainer}
      rangeMin={rangeMin}
      rangeMax={rangeMax}
      matchedLabels={matchedLabels}
      setRangeMin={setRangeMin}
      setRangeMax={setRangeMax}
      onItemFocused={(item) => setFocusedItemData(item)}
      focusedItemData={focusedItemData}
      textAlign={textAlign}
      sandwichItem={sandwichItem}
      onSandwich={onSandwich}
      onFocusPillClick={resetFocus}
      onSandwichPillClick={resetSandwich}
      colorScheme={colorScheme}
      showFlameGraphOnly={showFlameGraphOnly}
      collapsing={!disableCollapsing}
      getExtraContextMenuButtons={getExtraContextMenuButtons}
      selectedView={selectedView}
      search={search}
      collapsedMap={collapsedMap}
      setCollapsedMap={setCollapsedMap}
    />
  );

  const table = (
    <FlameGraphTopTableContainer
      data={dataContainer}
      onSymbolClick={onSymbolClick}
      search={search}
      matchedLabels={matchedLabels}
      sandwichItem={sandwichItem}
      onSandwich={setSandwichItem}
      onSearch={onSearch}
      onTableSort={onTableSortStable}
      colorScheme={colorScheme}
    />
  );

  let body;
  if (showFlameGraphOnly || selectedView === SelectedView.FlameGraph) {
    body = flameGraph;
  } else if (selectedView === SelectedView.TopTable) {
    body = <div className="plfg-table-container">{table}</div>;
  } else if (selectedView === SelectedView.Both) {
    if (vertical) {
      body = (
        <div>
          <div className="plfg-vertical-graph-container">{flameGraph}</div>
          <div className="plfg-vertical-table-container">{table}</div>
        </div>
      );
    } else {
      body = (
        <div className="plfg-horizontal-container">
          <div className="plfg-horizontal-table-container">{table}</div>
          <div className="plfg-horizontal-graph-container">{flameGraph}</div>
        </div>
      );
    }
  }

  return (
    <div ref={sizeRef} className="plfg-container">
      {!showFlameGraphOnly && (
        <FlameGraphHeader
          search={search}
          setSearch={setSearch}
          selectedView={selectedView}
          setSelectedView={(view) => {
            setSelectedView(view);
            onViewSelected?.(view);
          }}
          containerWidth={containerWidth}
          onReset={() => {
            resetFocus();
            resetSandwich();
          }}
          textAlign={textAlign}
          onTextAlignChange={(align) => {
            setTextAlign(align);
            onTextAlignSelected?.(align);
          }}
          showResetButton={Boolean(focusedItemData || sandwichItem)}
          colorScheme={colorScheme}
          onColorSchemeChange={setColorScheme}
          stickyHeader={Boolean(stickyHeader)}
          extraHeaderElements={extraHeaderElements}
          vertical={vertical}
          isDiffMode={dataContainer.isDiffFlamegraph()}
          setCollapsedMap={setCollapsedMap}
          collapsedMap={collapsedMap}
        />
      )}

      <div className="plfg-body">{body}</div>
    </div>
  );
};

/**
 * Based on the search string it does a fuzzy search over all the unique labels, so we can highlight them later.
 */
export function useLabelSearch(
  search: string | undefined,
  data: FlameGraphDataContainer | undefined,
): Set<string> | undefined {
  return useMemo(() => {
    if (!search || !data) {
      // In this case undefined means there was no search so no attempt to
      // highlighting anything should be made.
      return undefined;
    }

    return labelSearch(search, data);
  }, [search, data]);
}

export function labelSearch(
  search: string,
  data: FlameGraphDataContainer,
): Set<string> {
  const foundLabels = new Set<string>();
  const terms = search.split(',');

  const regexFilter = (labels: string[], pattern: string): boolean => {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch {
      return false;
    }

    let foundMatch = false;
    for (const label of labels) {
      if (!regex.test(label)) {
        continue;
      }

      foundLabels.add(label);
      foundMatch = true;
    }
    return foundMatch;
  };

  const fuzzyFilter = (labels: string[], term: string): boolean => {
    const idxs = ufuzzy.filter(labels, term);
    if (!idxs) {
      return false;
    }

    let foundMatch = false;
    for (const idx of idxs) {
      foundLabels.add(labels[idx]);
      foundMatch = true;
    }
    return foundMatch;
  };

  for (const term of terms) {
    if (!term) {
      continue;
    }

    const found = regexFilter(data.getUniqueLabels(), term);
    if (!found) {
      fuzzyFilter(data.getUniqueLabels(), term);
    }
  }

  return foundLabels;
}

export default FlameGraphContainer;

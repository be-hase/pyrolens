// This component is based on logic from the flamebearer project
// https://github.com/mapbox/flamebearer

// ISC License

// Copyright (c) 2018, Mapbox

// Permission to use, copy, modify, and/or distribute this software for any purpose
// with or without fee is hereby granted, provided that the above copyright notice
// and this permission notice appear in all copies.

// THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
// REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
// FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
// INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
// OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
// TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
// THIS SOFTWARE.
import { useEffect, useState } from 'react';

import { cx } from '../cx';
import {
  type ClickedItemData,
  type ColorScheme,
  type ColorSchemeDiff,
  type SelectedView,
  type TextAlign,
} from '../types';
import { Icon } from '../ui/Icon';

import FlameGraphCanvas from './FlameGraphCanvas';
import { type GetExtraContextMenuButtonsFunction } from './FlameGraphContextMenu';
import FlameGraphMetadata from './FlameGraphMetadata';
import {
  type CollapsedMap,
  type FlameGraphDataContainer,
  type LevelItem,
} from './dataTransform';

import './FlameGraph.css';

type Props = {
  data: FlameGraphDataContainer;
  rangeMin: number;
  rangeMax: number;
  matchedLabels?: Set<string>;
  setRangeMin: (range: number) => void;
  setRangeMax: (range: number) => void;
  onItemFocused: (data: ClickedItemData) => void;
  focusedItemData?: ClickedItemData;
  textAlign: TextAlign;
  sandwichItem?: string;
  onSandwich: (label: string) => void;
  onFocusPillClick: () => void;
  onSandwichPillClick: () => void;
  colorScheme: ColorScheme | ColorSchemeDiff;
  showFlameGraphOnly?: boolean;
  getExtraContextMenuButtons?: GetExtraContextMenuButtonsFunction;
  collapsing?: boolean;
  search: string;
  collapsedMap: CollapsedMap;
  setCollapsedMap: (collapsedMap: CollapsedMap) => void;
  selectedView?: SelectedView;
};

const FlameGraph = ({
  data,
  rangeMin,
  rangeMax,
  matchedLabels,
  setRangeMin,
  setRangeMax,
  onItemFocused,
  focusedItemData,
  textAlign,
  onSandwich,
  sandwichItem,
  onFocusPillClick,
  onSandwichPillClick,
  colorScheme,
  showFlameGraphOnly,
  getExtraContextMenuButtons,
  collapsing,
  search,
  collapsedMap,
  setCollapsedMap,
  selectedView,
}: Props) => {
  const [levels, setLevels] = useState<LevelItem[][]>();
  const [levelsCallers, setLevelsCallers] = useState<LevelItem[][]>();
  const [totalProfileTicks, setTotalProfileTicks] = useState<number>(0);
  const [totalProfileTicksRight, setTotalProfileTicksRight] =
    useState<number>();
  const [totalViewTicks, setTotalViewTicks] = useState<number>(0);

  useEffect(() => {
    if (data) {
      let levels = data.getLevels();
      let totalProfileTicks = levels.length ? levels[0][0].value : 0;
      let totalProfileTicksRight = levels.length
        ? levels[0][0].valueRight
        : undefined;
      let totalViewTicks = totalProfileTicks;
      let levelsCallers = undefined;

      if (sandwichItem) {
        const [callers, callees] = data.getSandwichLevels(sandwichItem);
        levels = callees;
        levelsCallers = callers;
        // We need this separate as in case of diff profile we want to compute
        // diff colors based on the original ticks.
        totalViewTicks = callees[0]?.[0]?.value ?? 0;
      }
      setLevels(levels);
      setLevelsCallers(levelsCallers);
      setTotalProfileTicks(totalProfileTicks);
      setTotalProfileTicksRight(totalProfileTicksRight);
      setTotalViewTicks(totalViewTicks);
    }
  }, [data, sandwichItem]);

  if (!levels) {
    return null;
  }

  const commonCanvasProps = {
    data,
    rangeMin,
    rangeMax,
    matchedLabels,
    setRangeMin,
    setRangeMax,
    onItemFocused,
    focusedItemData,
    textAlign,
    onSandwich,
    colorScheme,
    totalProfileTicks,
    totalProfileTicksRight,
    totalViewTicks,
    showFlameGraphOnly,
    collapsedMap,
    setCollapsedMap,
    getExtraContextMenuButtons,
    collapsing,
    search,
    selectedView,
  };
  let canvas = null;

  if (levelsCallers?.length) {
    canvas = (
      <>
        <div className="plfg-sandwich-canvas-wrapper">
          <div className="plfg-sandwich-marker">
            Callers
            <Icon className="plfg-sandwich-marker-icon" name={'angle-down'} />
          </div>
          <FlameGraphCanvas
            {...commonCanvasProps}
            root={levelsCallers[levelsCallers.length - 1][0]}
            depth={levelsCallers.length}
            direction={'parents'}
            // We do not support collapsing in sandwich view for now.
            collapsing={false}
          />
        </div>

        <div className="plfg-sandwich-canvas-wrapper">
          <div
            className={cx(
              'plfg-sandwich-marker',
              'plfg-sandwich-marker-callees',
            )}
          >
            <Icon className="plfg-sandwich-marker-icon" name={'angle-up'} />
            Callees
          </div>
          <FlameGraphCanvas
            {...commonCanvasProps}
            root={levels[0][0]}
            depth={levels.length}
            direction={'children'}
            collapsing={false}
          />
        </div>
      </>
    );
  } else if (levels?.length) {
    canvas = (
      <FlameGraphCanvas
        {...commonCanvasProps}
        root={levels[0][0]}
        depth={levels.length}
        direction={'children'}
      />
    );
  } else if (sandwichItem) {
    // getSandwichLevels found no frame with this label — a deep-linked or
    // shared-across-panes fgSandwich that does not exist in this profile
    // (wrong symbol, or a switch of profile type/service while sandwiched),
    // not a rendering bug. Left blank this reads as broken data (the
    // metadata pill above still shows "0 | 0 samples"); say so explicitly.
    // The pill's Reset/remove-sandwich control is unaffected — it lives in
    // FlameGraphMetadata below, not in this branch — and the URL param is
    // deliberately left alone: it may still be valid for the other
    // Comparison pane's profile. See VENDORED.md.
    canvas = (
      <div className="plfg-sandwich-empty">
        No frames match this symbol in this profile.
      </div>
    );
  }

  return (
    <div className="plfg-graph">
      <FlameGraphMetadata
        data={data}
        focusedItem={focusedItemData}
        sandwichedLabel={sandwichItem}
        totalTicks={totalViewTicks}
        onFocusPillClick={onFocusPillClick}
        onSandwichPillClick={onSandwichPillClick}
      />
      {canvas}
    </div>
  );
};

export default FlameGraph;

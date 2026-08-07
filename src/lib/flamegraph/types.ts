import { type LevelItem } from './FlameGraph/dataTransform';

export { type FlameGraphDataContainer } from './FlameGraph/dataTransform';

export { type ExtraContextMenuButton } from './FlameGraph/FlameGraphContextMenu';

export type ClickedItemData = {
  posX: number;
  posY: number;
  label: string;
  item: LevelItem;
};

export const SampleUnit = {
  Bytes: 'bytes',
  Short: 'short',
  Nanoseconds: 'ns',
} as const;
export type SampleUnit = (typeof SampleUnit)[keyof typeof SampleUnit];

export const SelectedView = {
  TopTable: 'topTable',
  FlameGraph: 'flameGraph',
  Both: 'both',
} as const;
export type SelectedView = (typeof SelectedView)[keyof typeof SelectedView];

export interface TableData {
  self: number;
  total: number;
  // For diff view
  totalRight: number;
}

export const ColorScheme = {
  ValueBased: 'valueBased',
  PackageBased: 'packageBased',
} as const;
export type ColorScheme = (typeof ColorScheme)[keyof typeof ColorScheme];

export const ColorSchemeDiff = {
  Default: 'default',
  DiffColorBlind: 'diffColorBlind',
} as const;
export type ColorSchemeDiff =
  (typeof ColorSchemeDiff)[keyof typeof ColorSchemeDiff];

export type TextAlign = 'left' | 'right';

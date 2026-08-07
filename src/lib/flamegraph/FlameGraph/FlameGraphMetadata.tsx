import { memo, type ReactNode } from 'react';

import { getValueFormat } from '../format';
import { type ClickedItemData } from '../types';
import { Icon } from '../ui/Icon';
import { IconButton } from '../ui/IconButton';

import { type FlameGraphDataContainer } from './dataTransform';

import './FlameGraphMetadata.css';

type Props = {
  data: FlameGraphDataContainer;
  totalTicks: number;
  onFocusPillClick: () => void;
  onSandwichPillClick: () => void;
  focusedItem?: ClickedItemData;
  sandwichedLabel?: string;
};

const FlameGraphMetadata = memo(
  ({
    data,
    focusedItem,
    totalTicks,
    sandwichedLabel,
    onFocusPillClick,
    onSandwichPillClick,
  }: Props) => {
    const parts: ReactNode[] = [];
    const ticksVal = getValueFormat('short')(totalTicks);

    const displayValue = data.valueDisplayProcessor(totalTicks);
    let unitValue = displayValue.text + displayValue.suffix;
    const unitTitle = data.getUnitTitle();
    if (unitTitle === 'Count') {
      if (!displayValue.suffix) {
        // Makes sure we don't show 123undefined or something like that if suffix isn't defined
        unitValue = displayValue.text;
      }
    }

    parts.push(
      <div className="plfg-metadata-pill" key={'default'}>
        {unitValue} | {ticksVal.text}
        {ticksVal.suffix} samples ({unitTitle})
      </div>,
    );

    if (sandwichedLabel) {
      parts.push(
        <div key={'sandwich'} title={sandwichedLabel}>
          <Icon size={'sm'} name={'angle-right'} />
          <div className="plfg-metadata-pill">
            <Icon size={'sm'} name={'sandwich'} />{' '}
            <span className="plfg-metadata-pill-name">
              {sandwichedLabel.substring(sandwichedLabel.lastIndexOf('/') + 1)}
            </span>
            <IconButton
              className="plfg-metadata-pill-close-button"
              name={'times'}
              size={'sm'}
              onClick={onSandwichPillClick}
              tooltip={'Remove sandwich view'}
              aria-label={'Remove sandwich view'}
            />
          </div>
        </div>,
      );
    }

    if (focusedItem) {
      const percentValue =
        totalTicks > 0
          ? Math.round(10000 * (focusedItem.item.value / totalTicks)) / 100
          : 0;
      const iconName = percentValue > 0 ? 'eye' : 'exclamation-circle';

      parts.push(
        <div key={'focus'} title={focusedItem.label}>
          <Icon size={'sm'} name={'angle-right'} />
          <div className="plfg-metadata-pill">
            <Icon size={'sm'} name={iconName} />
            &nbsp;{percentValue}% of total
            <IconButton
              className="plfg-metadata-pill-close-button"
              name={'times'}
              size={'sm'}
              onClick={onFocusPillClick}
              tooltip={'Remove focus'}
              aria-label={'Remove focus'}
            />
          </div>
        </div>,
      );
    }

    return <div className="plfg-metadata">{parts}</div>;
  },
);

FlameGraphMetadata.displayName = 'FlameGraphMetadata';

export default FlameGraphMetadata;

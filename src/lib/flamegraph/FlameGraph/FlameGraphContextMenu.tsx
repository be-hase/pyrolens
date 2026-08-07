import { type DataFrame } from '../data';
import { type ClickedItemData, type SelectedView } from '../types';
import { ContextMenu } from '../ui/ContextMenu';
import { type IconName } from '../ui/Icon';
import { MenuGroup, MenuItem } from '../ui/Menu';

import {
  type CollapseConfig,
  type FlameGraphDataContainer,
} from './dataTransform';

export type GetExtraContextMenuButtonsFunction = (
  clickedItemData: ClickedItemData,
  data: DataFrame,
  state: {
    selectedView?: SelectedView;
    isDiff: boolean;
    search: string;
    collapseConfig?: CollapseConfig;
  },
) => ExtraContextMenuButton[];

export type ExtraContextMenuButton = {
  label: string;
  icon: IconName;
  onClick: () => void;
};

type Props = {
  data: FlameGraphDataContainer;
  itemData: ClickedItemData;
  onMenuItemClick: () => void;
  onItemFocus: () => void;
  onSandwich: () => void;
  onExpandGroup: () => void;
  onCollapseGroup: () => void;
  onExpandAllGroups: () => void;
  onCollapseAllGroups: () => void;
  getExtraContextMenuButtons?: GetExtraContextMenuButtonsFunction;
  collapseConfig?: CollapseConfig;
  collapsing?: boolean;
  allGroupsCollapsed?: boolean;
  allGroupsExpanded?: boolean;
  selectedView?: SelectedView;
  search: string;
};

const FlameGraphContextMenu = ({
  data,
  itemData,
  onMenuItemClick,
  onItemFocus,
  onSandwich,
  collapseConfig,
  onExpandGroup,
  onCollapseGroup,
  onExpandAllGroups,
  onCollapseAllGroups,
  getExtraContextMenuButtons,
  collapsing,
  allGroupsExpanded,
  allGroupsCollapsed,
  selectedView,
  search,
}: Props) => {
  function renderItems() {
    const extraButtons =
      getExtraContextMenuButtons?.(itemData, data.data, {
        selectedView,
        isDiff: data.isDiffFlamegraph(),
        search,
        collapseConfig,
      }) || [];
    return (
      <>
        <MenuItem
          label="Focus block"
          icon={'eye'}
          onClick={() => {
            onItemFocus();
            onMenuItemClick();
          }}
        />
        <MenuItem
          label="Copy function name"
          icon={'copy'}
          onClick={() => {
            navigator.clipboard.writeText(itemData.label).then(() => {
              onMenuItemClick();
            });
          }}
        />
        <MenuItem
          label="Sandwich view"
          icon={'sandwich'}
          onClick={() => {
            onSandwich();
            onMenuItemClick();
          }}
        />
        {extraButtons.map(({ label, icon, onClick }) => {
          return (
            <MenuItem
              label={label}
              icon={icon}
              onClick={() => onClick()}
              key={label}
            />
          );
        })}
        {collapsing && (
          <MenuGroup label={'Grouping'}>
            {collapseConfig ? (
              collapseConfig.collapsed ? (
                <MenuItem
                  label="Expand group"
                  icon={'angle-double-down'}
                  onClick={() => {
                    onExpandGroup();
                    onMenuItemClick();
                  }}
                />
              ) : (
                <MenuItem
                  label="Collapse group"
                  icon={'angle-double-up'}
                  onClick={() => {
                    onCollapseGroup();
                    onMenuItemClick();
                  }}
                />
              )
            ) : null}
            {!allGroupsExpanded && (
              <MenuItem
                label="Expand all groups"
                icon={'angle-double-down'}
                onClick={() => {
                  onExpandAllGroups();
                  onMenuItemClick();
                }}
              />
            )}
            {!allGroupsCollapsed && (
              <MenuItem
                label="Collapse all groups"
                icon={'angle-double-up'}
                onClick={() => {
                  onCollapseAllGroups();
                  onMenuItemClick();
                }}
              />
            )}
          </MenuGroup>
        )}
      </>
    );
  }

  return (
    <div data-testid="contextMenu">
      <ContextMenu
        renderMenuItems={renderItems}
        x={itemData.posX + 10}
        y={itemData.posY}
        onClose={onMenuItemClick}
      />
    </div>
  );
};

export default FlameGraphContextMenu;

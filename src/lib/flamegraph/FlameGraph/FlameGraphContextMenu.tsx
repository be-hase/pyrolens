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

// `navigator.clipboard` only exists in a secure context (HTTPS or
// localhost); Pyrolens is commonly deployed over plain HTTP as an internal
// tool, where it is `undefined` and calling `.writeText` throws
// synchronously. Fall back to the classic hidden-textarea + `execCommand`
// path, and never let a rejection/throw escape uncaught.
async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the legacy path below (e.g. permission denied).
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  // Keep it out of the visible layout and off-screen so it never flashes.
  textarea.style.position = 'fixed';
  textarea.style.top = '-1000px';
  textarea.style.left = '-1000px';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    document.execCommand('copy');
  } catch {
    // Nothing more we can do; the menu still closes below.
  } finally {
    document.body.removeChild(textarea);
  }
}

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
            // Close the menu once the attempt is done, whether or not the
            // copy actually succeeded — a silent failure must not leave the
            // menu stuck open.
            copyText(itemData.label).finally(() => {
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

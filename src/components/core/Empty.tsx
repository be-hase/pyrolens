import { Button } from './Button';
import { Icon } from './Icon';
import './Empty.css';

export interface EmptyAction {
  label: string;
  onClick: () => void;
}

// Placeholder shown where a chart or table would render but there is
// nothing to show (no data in range, empty selection, ...). `action`, when
// given, renders a small secondary button under the message so an empty
// state can offer a way out instead of being a dead end. Stays dumb on
// purpose: callers decide the wording and what the action does.
export function Empty({
  message = 'No data available',
  action,
}: {
  message?: string;
  action?: EmptyAction;
}) {
  return (
    <div className="empty">
      <div className="empty-message">
        <Icon name="exclamation-circle" size={18} />
        <span>{message}</span>
      </div>
      {action && (
        <Button className="empty-action" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
}

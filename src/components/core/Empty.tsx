import { Icon } from './Icon';
import './Empty.css';

// Placeholder shown where a chart or table would render but there is
// nothing to show (no data in range, empty selection, ...).
export function Empty({ message = 'No data available' }: { message?: string }) {
  return (
    <div className="empty">
      <Icon name="exclamation-circle" size={18} />
      <span>{message}</span>
    </div>
  );
}

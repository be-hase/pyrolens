import './Panel.css';

// Titled section container: header row with an uppercase title on the left
// and, on the right, an optional actions slot (buttons) next to an optional
// monospace meta note, body below.
export function Panel({
  title,
  meta,
  actions,
  children,
}: {
  title: React.ReactNode;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const hasRight = actions != null || meta != null;
  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title">{title}</span>
        {hasRight && (
          <div className="panel-header-right">
            {actions != null && (
              <span className="panel-actions">{actions}</span>
            )}
            {meta != null && <span className="panel-meta">{meta}</span>}
          </div>
        )}
      </div>
      <div className="panel-body">{children}</div>
    </div>
  );
}

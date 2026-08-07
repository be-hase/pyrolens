import './Panel.css';

// Titled section container: header row with an uppercase title on the left
// and an optional monospace meta note on the right, body below.
export function Panel({
  title,
  meta,
  children,
}: {
  title: React.ReactNode;
  meta?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title">{title}</span>
        {meta != null && <span className="panel-meta">{meta}</span>}
      </div>
      <div className="panel-body">{children}</div>
    </div>
  );
}

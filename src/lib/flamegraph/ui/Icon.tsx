import { Icon as AppIcon, type IconType } from '@components/core/Icon';

export type IconName = IconType;

export type IconSize = 'sm' | 'md' | 'lg';

const PX: Record<IconSize, number> = { sm: 14, md: 16, lg: 18 };

export function Icon({
  name,
  size = 'md',
  className,
  title,
}: {
  name: IconName;
  size?: IconSize;
  className?: string;
  title?: string;
}) {
  const icon = <AppIcon name={name} size={PX[size]} className={className} />;

  if (!title) {
    return icon;
  }

  return (
    <span title={title} style={{ display: 'inline-flex' }}>
      {icon}
    </span>
  );
}

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import type { BoardProfile } from '../../lib/api/types';

export function ProfileSwitcher({
  profile,
  profiles,
  collapsed,
  onChoose,
}: {
  profile: string | null;
  profiles: BoardProfile[];
  collapsed?: boolean;
  onChoose: (name: string) => void;
}) {
  return (
    <Select value={profile ?? undefined} onValueChange={onChoose}>
      <SelectTrigger
        className={collapsed ? 'size-8 justify-center gap-0 p-0' : 'w-full'}
        aria-label="Profile"
      >
        {collapsed ? (
          <span className="text-sm font-semibold">
            {profile?.[0]?.toUpperCase() ?? '?'}
          </span>
        ) : (
          <SelectValue placeholder="Select profile" />
        )}
      </SelectTrigger>
      <SelectContent>
        {profiles.map((p) => (
          <SelectItem key={p.name} value={p.name}>
            {p.name}
            {p.connector === 'sqlite' ? '' : ' (no local db)'}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

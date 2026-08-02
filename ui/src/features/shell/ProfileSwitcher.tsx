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
  onChoose,
}: {
  profile: string | null;
  profiles: BoardProfile[];
  onChoose: (name: string) => void;
}) {
  return (
    <Select value={profile ?? undefined} onValueChange={onChoose}>
      <SelectTrigger className="w-full" aria-label="Profile">
        <SelectValue placeholder="Select profile" />
      </SelectTrigger>
      <SelectContent>
        {profiles.map((p) => (
          <SelectItem key={p.name} value={p.name}>
            {p.name}
            {p.hasDb ? '' : ' (no local db)'}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

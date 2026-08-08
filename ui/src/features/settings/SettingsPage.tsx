import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { navigate, type SettingsSection } from '../../lib/router';
import type { ConfigDocName } from './config.api';
import { JsonEscapeHatch } from './JsonEscapeHatch';
import { ProfileSection } from './sections/ProfileSection';
import { ScheduleSection } from './sections/ScheduleSection';

const TABS: { section: SettingsSection; label: string }[] = [
  { section: 'profile', label: 'Profile' },
  { section: 'schedule', label: 'Schedule' },
  { section: 'filters', label: 'Filters' },
  { section: 'resume', label: 'Resume' },
  { section: 'search-urls', label: 'Search URLs' },
  { section: 'danger', label: 'Danger zone' },
];

const SECTION_DOC: Partial<Record<SettingsSection, ConfigDocName>> = {
  profile: 'profile.json',
  schedule: 'profile.json',
  filters: 'filter.json',
  resume: 'resume.json',
  'search-urls': 'search_urls.md',
};

// Owned by later tasks: filters → 9, resume/search-urls → 10, danger → 11.
const PLACEHOLDER_COPY: Partial<Record<SettingsSection, string>> = {
  filters: 'Filter settings — coming soon.',
  resume: 'Resume settings — coming soon.',
  'search-urls': 'Search URL settings — coming soon.',
  danger: 'Danger zone — coming soon.',
};

function SectionBody({
  profile,
  section,
}: {
  profile: string;
  section: SettingsSection;
}) {
  if (section === 'profile') return <ProfileSection profile={profile} />;
  if (section === 'schedule') return <ScheduleSection profile={profile} />;
  return <p className="text-sm text-muted-foreground">{PLACEHOLDER_COPY[section]}</p>;
}

export function SettingsPage({
  profile,
  section,
}: {
  profile: string;
  section: SettingsSection;
}) {
  const doc = SECTION_DOC[section];
  return (
    <div className="flex flex-col gap-4 p-6">
      <h1 className="text-lg font-semibold font-heading">Settings</h1>
      <Tabs
        data-testid="settings-tabs"
        value={section}
        onValueChange={(value) =>
          navigate({ name: 'settings', section: value as SettingsSection })
        }
      >
        <TabsList>
          {TABS.map((tab) => (
            <TabsTrigger key={tab.section} value={tab.section}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value={section}>
          <div
            data-testid="settings-section"
            data-section={section}
            className="flex flex-col gap-4"
          >
            <SectionBody profile={profile} section={section} />
            {doc && <JsonEscapeHatch profile={profile} doc={doc} />}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

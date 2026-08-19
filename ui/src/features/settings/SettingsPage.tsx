import type { SettingsSection } from '../../lib/router';
import { SettingsShell } from './SettingsShell';
import { AboutYouSection } from './sections/AboutYouSection';
import { DangerZone } from './sections/DangerZone';
import { DeliverySection } from './sections/DeliverySection';
import { FetchingSection } from './sections/FetchingSection';
import { HousekeepingSection } from './sections/HousekeepingSection';
import { LandingSection } from './sections/LandingSection';
import { RawConfigSection } from './sections/RawConfigSection';
import { RolesCompaniesSection } from './sections/RolesCompaniesSection';
import { ScheduleSection } from './sections/ScheduleSection';
import { SkillsSection } from './sections/SkillsSection';
import { WhereJobsComeFromSection } from './sections/WhereJobsComeFromSection';
import { WhereYouWorkSection } from './sections/WhereYouWorkSection';

function SectionBody({
  profile,
  section,
}: {
  profile: string;
  section: SettingsSection;
}) {
  switch (section) {
    case 'landing':
      return <LandingSection profile={profile} />;
    case 'roles-companies':
      return <RolesCompaniesSection profile={profile} />;
    case 'where-you-work':
      return <WhereYouWorkSection profile={profile} />;
    case 'skills':
      return <SkillsSection profile={profile} />;
    case 'about-you':
      return <AboutYouSection profile={profile} />;
    case 'where-jobs-come-from':
      return <WhereJobsComeFromSection profile={profile} />;
    case 'schedule':
      return <ScheduleSection profile={profile} />;
    case 'fetching':
      return <FetchingSection profile={profile} />;
    case 'delivery':
      return <DeliverySection profile={profile} />;
    case 'housekeeping':
      return <HousekeepingSection profile={profile} />;
    case 'raw-config':
      return <RawConfigSection profile={profile} />;
    case 'danger':
      return <DangerZone profile={profile} />;
  }
}

export function SettingsPage({
  profile,
  section,
}: {
  profile: string;
  section: SettingsSection;
}) {
  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-6">
      <h1 className="text-lg font-semibold font-heading">Settings</h1>
      <SettingsShell section={section} profile={profile}>
        <SectionBody profile={profile} section={section} />
      </SettingsShell>
    </div>
  );
}

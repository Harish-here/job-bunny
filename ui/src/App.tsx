import { Toaster } from 'sonner';
import { SettingsSaveProvider } from './features/settings/save/SettingsSaveContext';
import { Shell } from './features/shell/Shell';

export default function App() {
  return (
    <SettingsSaveProvider>
      <Shell />
      <Toaster />
    </SettingsSaveProvider>
  );
}

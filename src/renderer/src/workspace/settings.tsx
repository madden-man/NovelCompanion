import { DriveSettingsSection } from './drive';

/**
 * ST-1: the settings screen. Each feature adds its own section here; the
 * Google Drive connection is the first (M9). Claude, appearance, and the
 * rest join it as their milestones land.
 */
export function SettingsView() {
  return (
    <section className="ws-wide stack" aria-labelledby="settings-title" data-testid="settings-view">
      <h2 id="settings-title">Settings</h2>
      <DriveSettingsSection />
    </section>
  );
}

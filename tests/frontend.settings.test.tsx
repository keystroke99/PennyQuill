import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import SettingsPage from '../src/pages/SettingsPage';
import type { AuthSession, ReferenceData } from '../src/types';

const references: ReferenceData = {
  members: [{ id: 'member-1', userId: 'user-1', name: 'Asha Rao', relationship: 'self', avatarIcon: 'user-round', active: true }],
  categories: [],
  accounts: [],
};

function renderSettings(role: AuthSession['user']['role']): string {
  const session: AuthSession = {
    user: { id: 'user-1', email: 'asha@example.com', displayName: 'Asha Rao', role, mustChangePassword: false },
    household: { id: 'household-1', name: 'Rao family', currency: 'INR', timezone: 'Asia/Kolkata' },
  };
  return renderToStaticMarkup(
    <SettingsPage
      session={session}
      references={references}
      onReferencesChanged={() => undefined}
      onImport={() => undefined}
      onLogout={() => undefined}
      installPrompt={null}
      standalone
      onInstallPromptConsumed={() => undefined}
    />,
  );
}

describe('family member settings', () => {
  it('shows accessible add, edit, and delete actions to writable users', () => {
    const html = renderSettings('member');
    expect(html).toContain('> Add</button>');
    expect(html).toContain('aria-label="Edit Asha Rao"');
    expect(html).toContain('aria-label="Delete Asha Rao"');
  });

  it('hides member mutation actions from viewers', () => {
    const html = renderSettings('viewer');
    expect(html).not.toContain('aria-label="Edit Asha Rao"');
    expect(html).not.toContain('aria-label="Delete Asha Rao"');
    expect(html).toContain('>Active</span>');
  });
});

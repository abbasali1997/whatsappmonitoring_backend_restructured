import * as fs from 'fs';
import * as path from 'path';

describe('Email templates', () => {
  const templatesDir = path.resolve(__dirname, '..', 'templates');

  it('credential templates should not include <img src="{{logoUrl}}">', () => {
    const credentialTemplates = [
      'email-verification.hbs',
      'reset-password.hbs',
      'manager-invitation.hbs',
    ];

    for (const t of credentialTemplates) {
      const content = fs.readFileSync(path.join(templatesDir, t), 'utf8');
      expect(content.includes('<img src="{{logoUrl}}"')).toBe(false);
    }
  });
});

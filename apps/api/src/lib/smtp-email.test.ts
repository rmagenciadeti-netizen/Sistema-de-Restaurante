import test from 'node:test';
import assert from 'node:assert/strict';
import { smtpEmailProviderFromEnv } from './smtp-email';

const smtpKeys = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM'] as const;

function withSmtpEnv(values: Partial<Record<typeof smtpKeys[number], string>>, run: () => void) {
  const previous = Object.fromEntries(smtpKeys.map(key => [key, process.env[key]]));
  for (const key of smtpKeys) delete process.env[key];
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  try { run(); }
  finally {
    for (const key of smtpKeys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('SMTP provider is absent when unconfigured and rejects partial or invalid settings', () => {
  withSmtpEnv({}, () => assert.equal(smtpEmailProviderFromEnv(), null));
  withSmtpEnv({ SMTP_USER: 'mailer' }, () => assert.throws(() => smtpEmailProviderFromEnv(), /SMTP_HOST and SMTP_FROM/));
  withSmtpEnv({ SMTP_HOST: 'mail.example.com' }, () => assert.throws(() => smtpEmailProviderFromEnv(), /SMTP_HOST and SMTP_FROM/));
  withSmtpEnv({ SMTP_HOST: 'mail.example.com', SMTP_FROM: 'noreply@example.com', SMTP_PORT: '70000' }, () => assert.throws(() => smtpEmailProviderFromEnv(), /SMTP_PORT/));
  withSmtpEnv({ SMTP_HOST: 'mail.example.com', SMTP_FROM: 'noreply@example.com', SMTP_USER: 'mailer' }, () => assert.throws(() => smtpEmailProviderFromEnv(), /SMTP_USER and SMTP_PASSWORD/));
});

test('SMTP provider uses configured transport options without sending until requested', () => {
  withSmtpEnv({ SMTP_HOST: 'mail.example.com', SMTP_FROM: 'noreply@example.com', SMTP_PORT: '587', SMTP_SECURE: 'false' }, () => {
    assert.equal(smtpEmailProviderFromEnv()?.name, 'smtp');
  });
});

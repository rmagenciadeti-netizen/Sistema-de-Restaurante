import { emailProviders, fiscalProviders } from './lib/providers';
import { FocusNfeProvider } from './lib/fiscal-focus';
import { SefazProvider } from './lib/fiscal-sefaz';
import { smtpEmailProviderFromEnv } from './lib/smtp-email';

// Payment providers require a deployment-specific certified adapter. Focus NFe is always available; each company enables it with its own token.
export function registerProviders() {
  const emailProvider = smtpEmailProviderFromEnv();
  if (emailProvider) emailProviders.register(emailProvider);
  if (process.env.FISCAL_FOCUSNFE_DISABLED !== 'true') fiscalProviders.register(new FocusNfeProvider());
  // Direct SEFAZ connector: signs with the company's A1 certificate and talks to the official web services (mutual TLS).
  fiscalProviders.register(new SefazProvider());
}

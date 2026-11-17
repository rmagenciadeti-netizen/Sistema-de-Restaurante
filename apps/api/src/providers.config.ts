import { emailProviders } from './lib/providers';
import { smtpEmailProviderFromEnv } from './lib/smtp-email';

// Payment and fiscal providers require a deployment-specific certified adapter.
export function registerProviders() {
  const emailProvider = smtpEmailProviderFromEnv();
  if (emailProvider) emailProviders.register(emailProvider);
}

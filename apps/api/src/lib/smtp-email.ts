import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { EmailMessage, EmailProvider } from './providers';

export class SmtpEmailProvider implements EmailProvider {
  readonly name = 'smtp';
  private readonly transporter: Transporter;

  constructor(options: { host: string; port: number; secure: boolean; user?: string; password?: string; from: string }) {
    this.transporter = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.secure,
      ...(options.user && options.password ? { auth: { user: options.user, pass: options.password } } : {}),
    });
    this.from = options.from;
  }

  private readonly from: string;

  async send(message: EmailMessage) {
    await this.transporter.sendMail({ from: this.from, ...message });
  }
}

export function smtpEmailProviderFromEnv() {
  const host = process.env.SMTP_HOST?.trim();
  const from = process.env.SMTP_FROM?.trim();
  const hasCredentials = Boolean(process.env.SMTP_USER || process.env.SMTP_PASSWORD);
  if (!host && !from && !hasCredentials) return null;
  if (!host || !from) throw new Error('SMTP_HOST and SMTP_FROM must both be configured');
  const port = Number(process.env.SMTP_PORT ?? '587');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SMTP_PORT must be a valid TCP port');
  const user = process.env.SMTP_USER?.trim();
  const password = process.env.SMTP_PASSWORD;
  if (Boolean(user) !== Boolean(password)) throw new Error('SMTP_USER and SMTP_PASSWORD must both be configured');
  const secureSetting = process.env.SMTP_SECURE;
  if (secureSetting !== undefined && secureSetting !== 'true' && secureSetting !== 'false') throw new Error('SMTP_SECURE must be true or false');
  const secure = secureSetting === undefined ? port === 465 : secureSetting === 'true';
  return new SmtpEmailProvider({ host, port, secure, from, ...(user && password ? { user, password } : {}) });
}

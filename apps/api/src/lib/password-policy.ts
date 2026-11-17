export function isStrongPassword(password: string): boolean {
  const classes = [/\p{Ll}/u, /\p{Lu}/u, /\p{N}/u, /[^\p{L}\p{N}]/u];
  return password.length >= 12
    && Buffer.byteLength(password, 'utf8') <= 72
    && classes.filter(pattern => pattern.test(password)).length >= 3;
}

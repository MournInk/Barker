export class DomainError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "DomainError";
  }
}

export function redactSecrets(message: string, secrets: string[], maximumLength = 1000): string {
  let result = message;
  for (const secret of secrets.filter(Boolean).sort((left, right) => right.length - left.length)) {
    let encoded = secret;
    try { encoded = encodeURIComponent(secret); } catch { /* malformed surrogate: literal redaction still applies */ }
    for (const variant of new Set([secret, encoded, JSON.stringify(secret).slice(1, -1)])) {
      result = result.split(variant).join("[redacted]");
    }
  }
  return result.slice(0, maximumLength);
}

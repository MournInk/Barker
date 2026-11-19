export class DomainError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "DomainError";
  }
}

export function redactSecrets(message: string, secrets: string[], maximumLength = 1000): string {
  const variants = new Set<string>();
  for (const secret of secrets.filter(Boolean)) {
    variants.add(secret);
    variants.add(JSON.stringify(secret).slice(1, -1));
    try { variants.add(encodeURIComponent(secret)); } catch {}
  }
  if (!variants.size) return message.slice(0, maximumLength);
  const pattern = [...variants].sort((left, right) => right.length - left.length)
    .map((variant) => variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return message.replace(new RegExp(pattern, "g"), "[redacted]").slice(0, maximumLength);
}

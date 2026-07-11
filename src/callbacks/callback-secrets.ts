export class CallbackSecretConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CallbackSecretConfigurationError';
  }
}

export function parseCallbackSigningSecrets(
  raw: string | undefined = process.env.CALLBACK_SIGNING_SECRETS
): Readonly<Record<string, string>> {
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CallbackSecretConfigurationError('CALLBACK_SIGNING_SECRETS must be valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CallbackSecretConfigurationError('CALLBACK_SIGNING_SECRETS must be a JSON object.');
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  for (const [secretId, value] of entries) {
    if (!secretId.trim() || typeof value !== 'string' || !value.trim()) {
      throw new CallbackSecretConfigurationError(
        'CALLBACK_SIGNING_SECRETS keys and values must be non-empty strings.'
      );
    }
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

export function resolveCallbackSigningSecret(secretId: string | undefined): string | undefined {
  if (!secretId) return undefined;
  return parseCallbackSigningSecrets()[secretId];
}

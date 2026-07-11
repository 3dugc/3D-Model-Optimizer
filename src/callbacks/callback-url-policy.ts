import { promises as dns } from 'dns';
import { BlockList, isIP } from 'net';
import { config } from '../config';

const MAX_CALLBACK_URL_LENGTH = 2048;

export interface CallbackUrlPolicyOptions {
  allowHttp?: boolean;
  allowPrivateNetworks?: boolean;
  allowedHosts?: readonly string[];
}

export interface CallbackResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type CallbackResolver = (hostname: string) => Promise<readonly CallbackResolvedAddress[]>;

export class CallbackUrlValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CallbackUrlValidationError';
  }
}

const blockedAddresses = new BlockList();

for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['192.175.48.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedAddresses.addSubnet(network, prefix, 'ipv4');
}

for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:2::', 48],
  ['2001:10::', 28],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['5f00::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  blockedAddresses.addSubnet(network, prefix, 'ipv6');
}

export const defaultCallbackResolver: CallbackResolver = async (hostname) => {
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => ({ address: entry.address, family: entry.family === 6 ? 6 : 4 }));
};

function effectivePolicy(options: CallbackUrlPolicyOptions): Required<CallbackUrlPolicyOptions> {
  const production = process.env.NODE_ENV === 'production';
  return {
    allowHttp: !production && (options.allowHttp ?? config.cloud.callbackAllowHttp),
    allowPrivateNetworks:
      !production && (options.allowPrivateNetworks ?? config.cloud.callbackAllowPrivateNetworks),
    allowedHosts: options.allowedHosts ?? config.cloud.callbackAllowedHosts,
  };
}

function normalizedHostname(hostname: string): string {
  const withoutBrackets = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return withoutBrackets.toLowerCase().replace(/\.$/, '');
}

function hostMatchesPattern(hostname: string, pattern: string): boolean {
  const normalizedPattern = normalizedHostname(pattern.trim());
  if (!normalizedPattern) return false;
  if (!normalizedPattern.startsWith('*.')) return hostname === normalizedPattern;
  const suffix = normalizedPattern.slice(1);
  return hostname.endsWith(suffix) && hostname.length > suffix.length;
}

function assertHostAllowed(hostname: string, allowedHosts: readonly string[]): void {
  if (!allowedHosts.length) return;
  if (!allowedHosts.some((pattern) => hostMatchesPattern(hostname, pattern))) {
    throw new CallbackUrlValidationError('Callback hostname is not in CALLBACK_ALLOWED_HOSTS.');
  }
}

export function isPublicCallbackAddress(address: string): boolean {
  const normalizedAddress = normalizedHostname(address);
  const family = isIP(normalizedAddress);
  if (family === 4) return !blockedAddresses.check(normalizedAddress, 'ipv4');
  if (family === 6) {
    if (normalizedAddress.startsWith('::ffff:')) return false;
    return !blockedAddresses.check(normalizedAddress, 'ipv6');
  }
  return false;
}

export function validateCallbackUrl(rawUrl: unknown, options: CallbackUrlPolicyOptions = {}): URL {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new CallbackUrlValidationError('Callback URL must be a non-empty string.');
  }
  const value = rawUrl.trim();
  if (value.length > MAX_CALLBACK_URL_LENGTH) {
    throw new CallbackUrlValidationError(`Callback URL exceeds ${MAX_CALLBACK_URL_LENGTH} characters.`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CallbackUrlValidationError('Callback URL is not a valid absolute URL.');
  }

  const policy = effectivePolicy(options);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && policy.allowHttp)) {
    throw new CallbackUrlValidationError('Callback URL must use HTTPS.');
  }
  if (url.username || url.password) {
    throw new CallbackUrlValidationError('Callback URL must not contain credentials.');
  }
  if (process.env.NODE_ENV === 'production' && url.port && url.port !== '443') {
    throw new CallbackUrlValidationError('Production callback URLs must use the standard HTTPS port 443.');
  }

  const hostname = normalizedHostname(url.hostname);
  if (!hostname) {
    throw new CallbackUrlValidationError('Callback URL must include a hostname.');
  }
  assertHostAllowed(hostname, policy.allowedHosts);

  const localHostname = hostname === 'localhost' || hostname.endsWith('.localhost');
  if (localHostname && !policy.allowPrivateNetworks) {
    throw new CallbackUrlValidationError('Callback URL must not target localhost.');
  }

  if (isIP(hostname) && !policy.allowPrivateNetworks && !isPublicCallbackAddress(hostname)) {
    throw new CallbackUrlValidationError('Callback URL must not target a private or reserved IP address.');
  }

  return url;
}

export async function assertCallbackDestinationIsSafe(
  url: URL,
  resolver: CallbackResolver = defaultCallbackResolver,
  options: CallbackUrlPolicyOptions = {}
): Promise<readonly CallbackResolvedAddress[]> {
  const policy = effectivePolicy(options);
  const hostname = normalizedHostname(url.hostname);
  const literalFamily = isIP(hostname);
  const addresses: readonly CallbackResolvedAddress[] = literalFamily
    ? [{ address: hostname, family: literalFamily === 6 ? 6 : 4 }]
    : await resolver(hostname);

  if (!addresses.length) {
    throw new Error(`DNS lookup returned no addresses for callback hostname ${hostname}.`);
  }
  for (const entry of addresses) {
    const actualFamily = isIP(normalizedHostname(entry.address));
    if (!actualFamily || actualFamily !== entry.family) {
      throw new CallbackUrlValidationError('Callback DNS lookup returned an invalid IP address.');
    }
    if (!policy.allowPrivateNetworks && !isPublicCallbackAddress(entry.address)) {
      throw new CallbackUrlValidationError('Callback hostname resolves to a private or reserved IP address.');
    }
  }
  return addresses;
}

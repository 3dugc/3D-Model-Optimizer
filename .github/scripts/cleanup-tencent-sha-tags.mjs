const registry = process.env.TENCENT_REGISTRY;
const imageName = process.env.TENCENT_IMAGE_NAME;
const username = process.env.TENCENT_REGISTRY_USERNAME;
const password = process.env.TENCENT_REGISTRY_PASSWORD;
const dryRun = process.env.DRY_RUN === 'true';

if (!registry) throw new Error('TENCENT_REGISTRY is required.');
if (!imageName) throw new Error('TENCENT_IMAGE_NAME is required.');
if (!username || !password) {
  throw new Error('Tencent registry credentials are not configured.');
}

const basicAuthHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
const baseUrl = `https://${registry}/v2/${imageName}`;
const manifestAccept = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

function parseBearerChallenge(header) {
  if (!header?.startsWith('Bearer ')) return undefined;
  const params = {};
  const value = header.slice('Bearer '.length);
  for (const match of value.matchAll(/([a-zA-Z_][a-zA-Z0-9_-]*)="([^"]*)"/g)) {
    params[match[1]] = match[2];
  }
  if (!params.realm) return undefined;
  return params;
}

async function getBearerToken(actions = 'pull,push,delete') {
  const challengeResponse = await fetch(`${baseUrl}/tags/list`);
  const challenge = parseBearerChallenge(challengeResponse.headers.get('www-authenticate'));
  if (!challenge) {
    throw new Error('Registry did not return a Bearer authentication challenge.');
  }

  const tokenUrl = new URL(challenge.realm);
  if (challenge.service) tokenUrl.searchParams.set('service', challenge.service);
  tokenUrl.searchParams.set('scope', `repository:${imageName}:${actions}`);

  const response = await fetch(tokenUrl, {
    headers: { Authorization: basicAuthHeader },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Token request failed: ${response.status} ${body}`);
  }
  const payload = await response.json();
  const token = payload.token || payload.access_token;
  if (!token) throw new Error('Token response did not contain token/access_token.');
  return token;
}

const bearerToken = await getBearerToken();
const headers = { Authorization: `Bearer ${bearerToken}` };

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...headers,
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${options.method || 'GET'} ${url} failed: ${response.status} ${body}`);
  }
  return response;
}

const tagsResponse = await request(`${baseUrl}/tags/list`);
const tagPayload = await tagsResponse.json();
const tags = Array.isArray(tagPayload.tags) ? tagPayload.tags : [];
const shortHashTags = tags.filter((tag) => /^sha-[0-9a-f]{7,40}$/i.test(tag));

console.log(`total_tags=${tags.length}`);
console.log(`short_hash_tags=${shortHashTags.length}`);

for (const tag of shortHashTags) {
  const manifestResponse = await request(`${baseUrl}/manifests/${encodeURIComponent(tag)}`, {
    headers: { Accept: manifestAccept },
  });
  const digest = manifestResponse.headers.get('docker-content-digest');
  if (!digest) {
    throw new Error(`Missing docker-content-digest for ${tag}`);
  }

  if (dryRun) {
    console.log(`dry-run delete ${tag} ${digest}`);
    continue;
  }

  await request(`${baseUrl}/manifests/${encodeURIComponent(digest)}`, {
    method: 'DELETE',
  });
  console.log(`deleted ${tag} ${digest}`);
}

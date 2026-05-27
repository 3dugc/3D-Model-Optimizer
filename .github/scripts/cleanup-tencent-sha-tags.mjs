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

const authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
const baseUrl = `https://${registry}/v2/${imageName}`;
const headers = { Authorization: authHeader };
const manifestAccept = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

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

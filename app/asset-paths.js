const MANIFEST_PATH = "asset-manifest.json";

export function manifestCandidates(baseUrl) {
  const pageUrl = new URL("./", baseUrl);
  return [
    new URL(`../ui/assets/${MANIFEST_PATH}`, pageUrl).href,
    new URL(`./ui/assets/${MANIFEST_PATH}`, pageUrl).href
  ].filter((url, index, urls) => urls.indexOf(url) === index);
}

export function assetUrlFromManifest(manifestUrl, file) {
  return new URL(file, manifestUrl).href;
}

export async function loadAssetManifest(fetchImpl, baseUrl) {
  const failures = [];
  for (const manifestUrl of manifestCandidates(baseUrl)) {
    try {
      const response = await fetchImpl(manifestUrl);
      if (!response.ok) {
        failures.push(`${manifestUrl} (${response.status} ${response.statusText || "request failed"})`);
        continue;
      }
      const manifest = await response.json();
      if (!manifest || !Array.isArray(manifest.assets)) {
        failures.push(`${manifestUrl} (invalid manifest: assets must be an array)`);
        continue;
      }
      return { manifest, manifestUrl };
    } catch (error) {
      failures.push(`${manifestUrl} (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  throw new Error(`Unable to load asset manifest. Tried: ${failures.join("; ")}`);
}

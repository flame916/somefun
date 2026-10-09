import assert from "node:assert/strict";
import { assetUrlFromManifest, loadAssetManifest, manifestCandidates } from "../app/asset-paths.js";

const localBase = "http://127.0.0.1:8000/game-project/code/";
assert.deepEqual(manifestCandidates(localBase), [
  "http://127.0.0.1:8000/game-project/ui/assets/asset-manifest.json",
  "http://127.0.0.1:8000/game-project/code/ui/assets/asset-manifest.json"
]);
assert.equal(
  assetUrlFromManifest("http://127.0.0.1:8000/game-project/ui/assets/asset-manifest.json", "bg_home_1440x900.png"),
  "http://127.0.0.1:8000/game-project/ui/assets/bg_home_1440x900.png"
);

const pagesBase = "https://flame916.github.io/somefun/";
assert.deepEqual(manifestCandidates(pagesBase), [
  "https://flame916.github.io/ui/assets/asset-manifest.json",
  "https://flame916.github.io/somefun/ui/assets/asset-manifest.json"
]);
const requests = [];
const pagesBundle = await loadAssetManifest(async (url) => {
  requests.push(url);
  if (url === "https://flame916.github.io/ui/assets/asset-manifest.json") {
    return { ok: false, status: 404, statusText: "Not Found" };
  }
  return { ok: true, status: 200, async json() { return { assets: [{ asset_id: "bg_home", file: "bg_home_1440x900.png" }] }; } };
}, pagesBase);
assert.deepEqual(requests, manifestCandidates(pagesBase));
assert.equal(pagesBundle.manifestUrl, "https://flame916.github.io/somefun/ui/assets/asset-manifest.json");
assert.equal(
  assetUrlFromManifest(pagesBundle.manifestUrl, pagesBundle.manifest.assets[0].file),
  "https://flame916.github.io/somefun/ui/assets/bg_home_1440x900.png"
);

await assert.rejects(
  () => loadAssetManifest(async () => ({ ok: false, status: 503, statusText: "Service Unavailable" }), pagesBase),
  /Unable to load asset manifest.*503 Service Unavailable/
);

console.log("asset paths ok: local project layout, GitHub Pages subpath fallback, asset resolution, and loader errors");

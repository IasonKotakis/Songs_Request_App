// Helpers for tools/deploy-cloudflare.mjs (kept separate so they can be tested).

// Writes the deploy config: the repo's wrangler.jsonc with the real database id filled in.
export function deployConfig(baseConfig, databaseId) {
  if (!/"database_id"\s*:\s*"[^"]*"/.test(baseConfig)) throw new Error('No database_id in wrangler.jsonc');
  return baseConfig.replace(/"database_id"\s*:\s*"[^"]*"/, `"database_id": "${databaseId}"`);
}

// Finds the database id in `wrangler d1 list --json` output.
export function findDatabaseId(listOutput, name = 'song-requests') {
  // Skip anything wrangler prints first (e.g. "[WARNING] ..."): the data is a JSON array of objects.
  const start = listOutput.search(/\[\s*(\{|\])/);
  if (start < 0) return null;
  try {
    const list = JSON.parse(listOutput.slice(start, listOutput.lastIndexOf(']') + 1));
    return list.find((db) => db.name === name)?.uuid || null;
  } catch {
    return null;
  }
}

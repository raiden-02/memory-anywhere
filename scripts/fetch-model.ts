// Downloads the pinned embedding model into a folder and checks every file's SHA-256 against
// config/models.json (retrieval.md §10). CI uses it to fill its model cache; tests then point
// MA_TEST_MODEL_DIR at the folder.
//
//   node scripts/fetch-model.ts <folder>

import { activeModel, downloadModel } from "../packages/server/src/embed/manifest.ts";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/fetch-model.ts <folder>");
  process.exit(2);
}
await downloadModel(dir, activeModel(), fetch, (f) => console.log(`verified ${f}`));
console.log(`model ready in ${dir}`);

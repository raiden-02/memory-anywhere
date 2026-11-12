// Child process for the migration fault test: migrates the store at argv[2], to be killed midway.

import { openStore } from "../../src/store/db.ts";
import { migrate } from "../../src/store/migrate.ts";

const file = process.argv[2] ?? "";
const db = openStore(file, { mode: "local" });
process.stdout.write("migrating\n");
await migrate(db, file);
db.close();

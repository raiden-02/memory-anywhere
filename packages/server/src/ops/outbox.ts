// The outbox (deployment-aws.md §4). The aws-mode server holds no AWS credentials, so everything
// that must leave the instance (an alert email, the setup token, a digest) is written as a file
// into `/run/memory-anywhere/outbox/`; a fixed script running as `ma-aws` acts on each file by
// its name and deletes it. A file appears atomically: it is written as `.<name>.tmp` (the script
// skips dot files) and renamed into place. Local mode has no outbox: nothing is sent anywhere.

import { closeSync, fsyncSync, openSync, renameSync, writeSync } from "node:fs";
import path from "node:path";

/** Every name the outbox script acts on; anything else would be deleted unread, so it is refused here. */
const NAMES = [
  /^setup-token$/u,
  /^setup-token\.delete$/u,
  /^alert-[a-z_]{1,40}\.json$/u,
  /^digest-\d{4}-\d{2}-\d{2}\.json$/u,
  /^fetch-[0-9A-HJKMNP-TV-Z]{26}$/u,
] as const;

export interface Outbox {
  /** Hands `content` to the outbox script under `name`. Returns false where there is no outbox. */
  send(name: string, content: string): boolean;
}

/** Local mode, tests: nothing leaves the process. */
export const NO_OUTBOX: Outbox = { send: () => false };

export class FileOutbox implements Outbox {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  send(name: string, content: string): boolean {
    if (!NAMES.some((re) => re.test(name))) throw new Error(`not an outbox file name: ${name}`);
    const tmp = path.join(this.#dir, `.${name}.tmp`);
    // 0660: the outbox script reads it as a member of the server's group (the unit's UMask is 0007).
    const fd = openSync(tmp, "w", 0o660);
    try {
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path.join(this.#dir, name));
    return true;
  }
}

/** The outbox sits next to the server's socket: `/run/memory-anywhere/http.sock` → `/run/memory-anywhere/outbox`. */
export function outboxDirFor(socketPath: string): string {
  return path.join(path.dirname(socketPath), "outbox");
}

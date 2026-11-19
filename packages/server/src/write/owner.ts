// The owner as a caller of the write path: from the admin UI or `mema`, at trust tier 0, never asked a
// question (an owner action is already the owner's answer).

import { LOCAL_CLIENT_ID } from "../store/init.ts";
import type { Caller } from "./types.ts";

export function ownerCaller(channel: Caller["channel"]): Caller {
	return {
		clientId: LOCAL_CLIENT_ID,
		clientClass: "coding",
		channel,
		tier: 0,
		sessionKey: "admin",
		repoKey: undefined,
		tool: undefined,
		floored: false,
		canElicit: false,
		elicitationAnswer: undefined,
	};
}

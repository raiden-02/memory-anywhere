// What the admin pages show instead of internal names: who a memory came from (its trust tier), what an
// alert means and what to do about it, what a review item asks, and what a sensitive category is about.
// Templates get these as `it.fmt`.

import type { AlertKind } from "../ops/alerts.ts";
import type { SensitiveCategory } from "../policy/generated.ts";
import type { ReviewKind } from "../write/rows.ts";

/** Lower is more trusted (write-path.md §2.1). */
const TIER: Readonly<Record<number, string>> = {
	0: "from you",
	1: "confirmed by you in an app",
	2: "from an app",
	3: "from an import",
};

interface AlertText {
	readonly title: string;
	readonly action: string;
}

const ALERT_TEXT: Readonly<Record<AlertKind, AlertText>> = {
	grant_created: { title: "An app was connected", action: "If you did not connect it, disconnect it under Apps." },
	pairing_race: {
		title: "Two apps tried to pair at once",
		action: "Disconnect any app under Apps that you do not recognise.",
	},
	registration_refused: {
		title: "An app's registration was refused",
		action: "Open a pairing window again if you were connecting an app.",
	},
	owner_reset_requested: {
		title: "Someone asked to reset the owner's passkeys",
		action: "If it was not you, cancel it now on this page.",
	},
	restored: {
		title: "The store was restored from a backup",
		action: "Check that your apps still connect; sign in again where they do not.",
	},
	manifest_mismatch: {
		title: "The store's history differs from its locked record",
		action: "Stop and restore from a backup; see the restore guide.",
	},
	store_imported: { title: "A store export was imported", action: "If you did not import it, restore from a backup." },
	stepup_unexpected: {
		title: "Approvals were asked for that you did not expect",
		action: "Deny any you did not start, and check the PC that asked.",
	},
	refresh_reuse: {
		title: "An app's sign-in token was used twice",
		action: "Disconnect that app under Apps and connect it again.",
	},
	auth_fail: { title: "Repeated failed sign-ins", action: "If it was not you, check your passkeys under System." },
	passkey_clone: {
		title: "A passkey may have been copied",
		action: "It is blocked; confirm with another passkey, then replace it.",
	},
	save_quota: { title: "An app saved more than its hourly quota", action: "Review its recent saves under Changes." },
	forget_quota: {
		title: "An app forgot more than its daily quota",
		action: "Review its recent changes and undo any you did not want.",
	},
	read_budget: {
		title: "An app read more than its budget",
		action: "Check what it read; lower its budget or disconnect it under Apps.",
	},
	supersede_remote: {
		title: "An app replaced a memory you confirmed",
		action: "Check the change under Changes and undo it if wrong.",
	},
	disk_low: { title: "The server's disk is nearly full", action: "Free space, or grow the volume." },
	llm_cap: {
		title: "The month's model spending cap was reached",
		action: "Extraction pauses until next month, or raise the cap.",
	},
	job_failed: {
		title: "A background job failed",
		action: "It retries on its own; if this repeats, check the server's log.",
	},
	recovery_used: {
		title: "A recovery code was used",
		action: "If it was not you, add a new passkey and remove the old ones.",
	},
};

const REVIEW: Readonly<Record<ReviewKind, string>> = {
	instruction: "A standing rule for how your apps behave",
	sensitive: "A sensitive fact",
	import_sensitive: "A sensitive fact from an import",
	forget_protected: "An app asked to forget something you confirmed",
	contested: "Two memories disagree",
	preference_confirm: "A preference to confirm",
	project_proposal: "A new project",
	render_sensitive: "A memory an app showed that may be sensitive",
};

const TOPIC: Readonly<Record<SensitiveCategory, string>> = {
	health: "Health",
	finances: "Money",
	religion: "Religion",
	politics: "Politics",
	sexual_life: "Sex life",
	immigration: "Immigration",
	criminal: "Criminal history",
	home_address: "Home address",
};

export const fmt = {
	tier: (t: number): string => TIER[t] ?? `tier ${t}`,
	alert: (kind: string): string => ALERT_TEXT[kind as AlertKind]?.title ?? kind,
	alertAction: (kind: string): string | undefined => ALERT_TEXT[kind as AlertKind]?.action,
	review: (kind: string): string => REVIEW[kind as ReviewKind] ?? kind,
	topic: (category: string): string => TOPIC[category as SensitiveCategory] ?? category,
	/**
	 * A timestamp as HTML, which the page's script shows in the viewer's own time zone (the server does
	 * not know it); the UTC text stays as a fallback. Only an ISO UTC timestamp becomes markup: the
	 * template prints this unescaped.
	 */
	time: (iso: string | null | undefined): string =>
		iso && ISO_UTC.test(iso) ? `<time datetime="${iso}">${iso.slice(0, 16).replace("T", " ")} UTC</time>` : "",
};

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/u;

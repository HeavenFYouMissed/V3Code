/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
export interface Env {
	RELEASES: R2Bucket;
	/** Download/install analytics, anonymous runtime milestones, and product votes. */
	ANALYTICS?: D1Database;
	/** Bearer token gating GET /api/stats (the readout exposes IPs). */
	ADMIN_TOKEN?: string;
}

/** Manifest schema written to R2 by CI at manifests/{quality}/{platform}/latest.json.
 *  `version` is the build commit id (matches VSElite's IUpdate.version contract),
 *  not the semver — productVersion carries the semver for humans/UI. */
export interface ReleaseManifest {
	version: string;
	productVersion: string;
	timestamp: number;
	url: string;
	sha256hash: string;
	name: string;
	/**
	 * Commits that are known to be older than this artifact and may update to it.
	 *
	 * Git SHAs themselves have no ordering. Unknown commits therefore receive 204 instead of being
	 * told to install an arbitrary different build. A deliberate rollback is represented by adding
	 * the newer commit explicitly when publishing the rollback manifest.
	 */
	supersedes?: string[];
}

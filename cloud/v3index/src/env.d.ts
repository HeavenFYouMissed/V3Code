/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
export interface Env {
	WORKSPACE: DurableObjectNamespace;
	/** Standard Qwen vector space. Kept on the original binding/index for
	 * backwards compatibility with already-synced workspaces. */
	VECTORS: VectorizeIndex;
	/** Advanced Voyage Code 3 vector space. Never query or write Voyage vectors
	 * through VECTORS: equal dimensions do not make model spaces compatible. */
	VECTORS_VOYAGE?: VectorizeIndex;
	BLOBS: R2Bucket;
	EMBED_QUEUE: Queue<EmbedJob>;
	KEYS: KVNamespace;
	AI: Ai;
	EMBED_MODEL: string;
	EMBED_DIM: string;
	VOYAGE_MODEL?: string;
	VOYAGE_DIM?: string;
	VOYAGE_API_KEY?: string;
	/** HMAC key for stateless workspace tokens (P0 auth; real key registry is P1). */
	MASTER_KEY_SECRET: string;
	/** Shared only with the Superclaw control plane. Signs 15-minute paid-plan
	 *  read/write sessions; it cannot mint admin credentials. */
	SESSION_KEY_SECRET?: string;
}

/** One embed job = a batch of chunk ids belonging to one workspace. The consumer
 *  fetches embed text from the workspace DO (never carried on the queue — 128KB
 *  message cap and no plaintext on the wire in vectors-only mode). */
export interface EmbedJob {
	workspaceId: string;
	chunkIds: string[];
	indexProfile?: 'standard' | 'advanced';
	/** Salted embed identity these vectors will be stored under. */
	embedIdentity: string;
}

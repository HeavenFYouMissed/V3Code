/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		// update/ is a self-contained subproject (own wrangler.jsonc with the
		// RELEASES binding this parent config lacks) — run its suite from
		// update/, not here.
		exclude: ['update/**', 'node_modules/**'],
		poolOptions: {
			workers: {
				// SQLite-backed DOs leave WAL/-shm files that trip the per-test
				// storage stacker (known vitest-pool-workers issue) — run with
				// shared storage; tests use distinct workspace ids instead.
				isolatedStorage: false,
				singleWorker: true,
				// Never load the production account/bindings in tests. Vectorize and
				// Workers AI are remote-proxy-only in Miniflare; using wrangler.jsonc
				// here can open an OAuth browser and touch live infrastructure.
				wrangler: { configPath: './wrangler.test.jsonc' },
				miniflare: {
					bindings: {
						MASTER_KEY_SECRET: 'test-master-secret',
						SESSION_KEY_SECRET: 'test-session-secret-that-is-at-least-32-bytes',
					},
				},
			},
		},
	},
});

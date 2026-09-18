/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
// Mint an HMAC dev/bootstrap token for V3Index.
//   node scripts/mint-token.mjs <MASTER_KEY_SECRET> <workspaceId|*> <read|write|admin>
// The root admin token (for /v1/admin/keys) is: workspaceId '*', scope 'admin'.
import { createHmac } from 'node:crypto';

const [master, wsId, scope] = process.argv.slice(2);
if (!master || !wsId || !['read', 'write', 'admin'].includes(scope ?? '')) {
	console.error('usage: node scripts/mint-token.mjs <MASTER_KEY_SECRET> <workspaceId|*> <read|write|admin>');
	process.exit(1);
}
const sig = createHmac('sha256', master).update(`${wsId}:${scope}`).digest('base64url');
console.log(sig);

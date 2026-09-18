/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
// Worker script for browser tests – echoes messages back
self.onmessage = e => self.postMessage(e.data);

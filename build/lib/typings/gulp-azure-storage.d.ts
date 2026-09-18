/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
declare module 'gulp-azure-storage' {
	import { ThroughStream } from 'event-stream';

	export function upload(options: any): ThroughStream;
}

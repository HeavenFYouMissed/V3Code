/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
declare module 'merge2' {
	import { PassThrough } from 'stream';

	interface Merge2Options {
		end?: boolean;
		objectMode?: boolean;
		pipeError?: boolean;
		highWaterMark?: number;
	}

	interface Merge2Stream extends PassThrough {
		add(...streams: Array<NodeJS.ReadableStream | NodeJS.ReadableStream[]>): this;
	}

	function merge2(streams: NodeJS.ReadableStream[], options?: Merge2Options): Merge2Stream;

	export default merge2;
}

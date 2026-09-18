/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
declare module 'ternary-stream' {
	import File = require('vinyl');
	function f(check: (f: File) => boolean, onTrue: NodeJS.ReadWriteStream, opnFalse?: NodeJS.ReadWriteStream): NodeJS.ReadWriteStream;

	/**
	 * This is required as per:
	 * https://github.com/microsoft/TypeScript/issues/5073
	 */
	namespace f {}

	export = f;
}

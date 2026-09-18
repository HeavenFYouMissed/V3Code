/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
/*---------------------------------------------------------------------------------------------
 *  Optional dependency — types only; runtime loads via dynamic import.
 *--------------------------------------------------------------------------------------------*/

declare module 'webcrack' {
	export function webcrack(
		code: string,
		options?: { jsx?: boolean; unpack?: boolean; unminify?: boolean; deobfuscate?: boolean },
	): Promise<{ save: (outputDir: string) => Promise<void>; bundle?: { type?: string } }>;
}

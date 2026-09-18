/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
import { URI } from '../../../../base/common/uri.js';

export type VoidDirectoryItem = {
	uri: URI;
	name: string;
	isSymbolicLink: boolean;
	children: VoidDirectoryItem[] | null;
	isDirectory: boolean;
	isGitIgnoredDirectory: false | { numChildren: number }; // if directory is gitignored, we ignore children
}

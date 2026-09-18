/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
const completionSpec: Fig.Spec = {
	name: "pwd",
	description: "Return working directory name",
	options: [
		{
			name: "-L",
			description: "Display the logical current working directory",
		},
		{
			name: "-P",
			description: "Display the physical current working directory",
		},
	],
};

export default completionSpec;

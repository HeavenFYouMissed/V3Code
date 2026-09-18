/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
const completionSpec: Fig.Spec = {
	name: "rmdir",
	description: "Remove directories",
	args: {
		isVariadic: true,
		template: "folders",
	},

	options: [
		{
			name: "-p",
			description: "Remove each directory of path",
			isDangerous: true,
		},
	],
};

export default completionSpec;

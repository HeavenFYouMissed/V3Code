/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
const completionSpec: Fig.Spec = {
	name: "tee",
	description: "Duplicate standard input",
	options: [
		{
			name: "-a",
			description:
				"Append the output to the files rather than overwriting them",
		},
		{
			name: "-i",
			description: "Ignore the SIGINT signal",
		},
	],
	args: {
		name: "file",
		description: "Pathname of an output file",
		isVariadic: true,
		template: "filepaths",
	},
};
export default completionSpec;

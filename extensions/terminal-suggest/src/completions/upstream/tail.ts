/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
const completionSpec: Fig.Spec = {
	name: "tail",
	description: "Display the last part of a file",
	args: {
		isVariadic: true,
		template: "filepaths",
	},
	options: [
		{
			name: "-f",
			description: "Wait for additional data to be appended",
		},
		{
			name: "-r",
			description: "Display in reverse order",
		},
	],
};

export default completionSpec;

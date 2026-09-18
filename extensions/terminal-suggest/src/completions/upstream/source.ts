/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
const completionSpec: Fig.Spec = {
	name: "source",
	description: "Source files in shell",
	args: {
		isVariadic: true,
		name: "File to source",
		template: "filepaths",
	},
};

export default completionSpec;

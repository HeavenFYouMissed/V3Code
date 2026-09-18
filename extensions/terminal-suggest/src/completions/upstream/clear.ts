/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
const completionSpec: Fig.Spec = {
	name: "clear",
	description: "Clear the terminal screen",
	options: [
		{
			name: "-T",
			description: "Indicates the type of terminal",
			args: {
				name: "type",
			},
		},
		{
			name: "-V",
			description: "Reports version of ncurses used in this program, and exits",
		},
		{
			name: "-x",
			description:
				"Do not attempt to clear terminal's scrollback buffer using the extended E3 capability",
		},
	],
};

export default completionSpec;

/*---------------------------------------------------------------------------------------------
*  Copyright (c) Microsoft Corporation. All rights reserved.
*  Licensed under the MIT License. See License.txt in the project root for license information.
*--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

declare module '@emmetio/html-matcher' {
	import { BufferStream, HtmlNode } from 'EmmetNode';
	import { HtmlNode as HtmlFlatNode } from 'EmmetFlatNode';

	function parse(stream: BufferStream): HtmlNode;
	function parse(stream: string): HtmlFlatNode;

	export default parse;
}


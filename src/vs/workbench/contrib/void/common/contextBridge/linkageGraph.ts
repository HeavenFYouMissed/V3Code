/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Thin seam for the future IWE / iwec markdown-as-graph port (Phase 2 catalog).
 * Call sites depend on LinkageGraph, not a concrete iwec runtime.
 */

import { VSBuffer } from '../../../../../base/common/buffer.js';
import { dirname } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';

export interface LinkageNode {
	id: string;
	label: string;
	kind: string;
}

export interface LinkageEdge {
	from: string;
	to: string;
	relation: string;
}

export interface LinkageGraphSnapshot {
	nodes: LinkageNode[];
	edges: LinkageEdge[];
}

/** Port surface for markdown permanent-layer inclusion links (catalog implements iwec or native TS). */
export interface LinkageGraph {
	readSnapshot(): Promise<LinkageGraphSnapshot>;
	addEdge(from: string, to: string, relation: string): Promise<void>;
}

interface LinkageGraphFile {
	nodes: LinkageNode[];
	edges: LinkageEdge[];
}

const EMPTY: LinkageGraphFile = { nodes: [], edges: [] };

/** Trivial filesystem-backed default — JSON file in the permanent layer root. */
export class FileLinkageGraph implements LinkageGraph {
	constructor(
		private readonly graphUri: URI,
		private readonly fileService: IFileService,
	) { }

	private async readFile(): Promise<LinkageGraphFile> {
		if (!(await this.fileService.exists(this.graphUri))) {
			return { ...EMPTY, nodes: [], edges: [] };
		}
		try {
			const raw = (await this.fileService.readFile(this.graphUri)).value.toString();
			const data = JSON.parse(raw) as LinkageGraphFile;
			return {
				nodes: Array.isArray(data.nodes) ? data.nodes : [],
				edges: Array.isArray(data.edges) ? data.edges : [],
			};
		} catch {
			return { ...EMPTY, nodes: [], edges: [] };
		}
	}

	private async writeFile(data: LinkageGraphFile): Promise<void> {
		await this.fileService.createFolder(dirname(this.graphUri));
		await this.fileService.writeFile(this.graphUri, VSBuffer.fromString(JSON.stringify(data, null, 2)));
	}

	async readSnapshot(): Promise<LinkageGraphSnapshot> {
		const data = await this.readFile();
		return { nodes: [...data.nodes], edges: [...data.edges] };
	}

	async addEdge(from: string, to: string, relation: string): Promise<void> {
		const data = await this.readFile();
		data.edges.push({ from, to, relation });
		await this.writeFile(data);
	}
}

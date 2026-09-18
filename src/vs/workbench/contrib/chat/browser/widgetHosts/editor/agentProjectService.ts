/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
/*---------------------------------------------------------------------------------------------
 *  V3Code — Agent Project Service
 *
 *  Persistent local project grouping for agent sessions. Projects are named
 *  containers with an icon and colour that sessions can be assigned to. The
 *  sidebar renders them as collapsible sections, giving the rail the same
 *  "Projects / Pinned / Cloud / This Mac" hierarchy that Cursor ships.
 *
 *  Data model (persisted to StorageScope.APPLICATION):
 *    projects  → { id, name, icon, color, createdAt }[]
 *    membership → { [sessionResourceUri]: projectId }
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../../base/common/uuid.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';

// ---------------------------------------------------------------------------
//  Types
// ---------------------------------------------------------------------------

export interface IAgentProject {
	readonly id: string;
	name: string;
	icon: string;   // codicon id, e.g. 'folder-library'
	color: string;  // hex, e.g. '#6AA3CC'
	readonly createdAt: number;
}

export interface IAgentProjectService {
	readonly _serviceBrand: undefined;

	readonly onDidChange: Event<void>;

	/** All projects, ordered by creation time. */
	getProjects(): readonly IAgentProject[];

	/** Look up a single project by id. */
	getProject(id: string): IAgentProject | undefined;

	/** Create a new project. Returns the new id. */
	createProject(name: string, icon?: string, color?: string): string;

	/** Rename an existing project. */
	renameProject(id: string, name: string): void;

	/** Update icon and/or colour. */
	updateProject(id: string, patch: { icon?: string; color?: string }): void;

	/** Delete a project and unassign all its sessions. */
	deleteProject(id: string): void;

	/** Assign a session to a project (or clear with undefined). */
	setMembership(sessionUri: string, projectId: string | undefined): void;

	/** Which project does this session belong to? */
	getMembership(sessionUri: string): string | undefined;

	/** All session URIs assigned to a given project. */
	getSessionsForProject(projectId: string): string[];
}

export const IAgentProjectService = createDecorator<IAgentProjectService>('agentProjectService');

// ---------------------------------------------------------------------------
//  Storage keys
// ---------------------------------------------------------------------------

const PROJECTS_KEY = 'v3code.agentProjects.v1';
const MEMBERSHIP_KEY = 'v3code.agentProjectMembership.v1';

// ---------------------------------------------------------------------------
//  Default palette — the colours from the Cursor "Create Project" picker
// ---------------------------------------------------------------------------

const DEFAULT_COLORS = [
	'#6AA3CC', '#5CB87A', '#8B5CF6', '#3B82F6',
	'#A78BFA', '#F59E0B', '#EC4899', '#EF4444',
];

// ---------------------------------------------------------------------------
//  Implementation
// ---------------------------------------------------------------------------

export class AgentProjectServiceImpl extends Disposable implements IAgentProjectService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private _projects: IAgentProject[] = [];
	private readonly _projectsById = new Map<string, IAgentProject>();
	private readonly _membership = new Map<string, string>(); // sessionUri → projectId

	constructor(
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this._load();
	}

	// -- queries --

	getProjects(): readonly IAgentProject[] {
		return this._projects;
	}

	getProject(id: string): IAgentProject | undefined {
		return this._projectsById.get(id);
	}

	getMembership(sessionUri: string): string | undefined {
		return this._membership.get(sessionUri);
	}

	getSessionsForProject(projectId: string): string[] {
		const result: string[] = [];
		for (const [uri, pid] of this._membership) {
			if (pid === projectId) {
				result.push(uri);
			}
		}
		return result;
	}

	// -- mutations --

	createProject(name: string, icon = 'folder-library', color?: string): string {
		const id = generateUuid();
		const project: IAgentProject = {
			id,
			name,
			icon,
			color: color ?? DEFAULT_COLORS[this._projects.length % DEFAULT_COLORS.length],
			createdAt: Date.now(),
		};
		this._projects.push(project);
		this._projectsById.set(id, project);
		this._persistProjects();
		this._onDidChange.fire();
		return id;
	}

	renameProject(id: string, name: string): void {
		const p = this._projectsById.get(id);
		if (!p) { return; }
		p.name = name;
		this._persistProjects();
		this._onDidChange.fire();
	}

	updateProject(id: string, patch: { icon?: string; color?: string }): void {
		const p = this._projectsById.get(id);
		if (!p) { return; }
		if (patch.icon !== undefined) { p.icon = patch.icon; }
		if (patch.color !== undefined) { p.color = patch.color; }
		this._persistProjects();
		this._onDidChange.fire();
	}

	deleteProject(id: string): void {
		this._projects = this._projects.filter(p => p.id !== id);
		this._projectsById.delete(id);
		// Unassign all sessions from this project
		for (const [uri, pid] of this._membership) {
			if (pid === id) {
				this._membership.delete(uri);
			}
		}
		this._persistProjects();
		this._persistMembership();
		this._onDidChange.fire();
	}

	setMembership(sessionUri: string, projectId: string | undefined): void {
		if (projectId === undefined) {
			this._membership.delete(sessionUri);
		} else {
			this._membership.set(sessionUri, projectId);
		}
		this._persistMembership();
		this._onDidChange.fire();
	}

	// -- persistence --

	private _load(): void {
		// Projects
		const raw = this.storageService.get(PROJECTS_KEY, StorageScope.APPLICATION);
		if (raw) {
			try {
				const arr: IAgentProject[] = JSON.parse(raw);
				for (const p of arr) {
					this._projects.push(p);
					this._projectsById.set(p.id, p);
				}
			} catch { /* corrupt — start fresh */ }
		}

		// Membership
		const rawM = this.storageService.get(MEMBERSHIP_KEY, StorageScope.APPLICATION);
		if (rawM) {
			try {
				const map: Record<string, string> = JSON.parse(rawM);
				for (const [k, v] of Object.entries(map)) {
					this._membership.set(k, v);
				}
			} catch { /* corrupt */ }
		}
	}

	private _persistProjects(): void {
		this.storageService.store(
			PROJECTS_KEY,
			JSON.stringify(this._projects),
			StorageScope.APPLICATION,
			StorageTarget.USER,
		);
	}

	private _persistMembership(): void {
		this.storageService.store(
			MEMBERSHIP_KEY,
			JSON.stringify(Object.fromEntries(this._membership)),
			StorageScope.APPLICATION,
			StorageTarget.USER,
		);
	}
}

// ---------------------------------------------------------------------------
//  Registration
//
//  MUST stay in this file, directly below the implementation. AgentWorkspaceShell
//  injects @IAgentProjectService in its constructor; without this singleton the
//  instantiation service throws while constructing ChatEditor, which surfaces to
//  the user as "The editor could not be opened due to an unexpected error" and
//  leaves the whole agent panel dead. Delayed instantiation is correct here —
//  nothing needs the service until the shell first renders.
// ---------------------------------------------------------------------------

registerSingleton(IAgentProjectService, AgentProjectServiceImpl, InstantiationType.Delayed);

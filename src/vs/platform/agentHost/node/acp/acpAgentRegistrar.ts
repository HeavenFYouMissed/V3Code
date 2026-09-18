/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../instantiation/common/instantiation.js';
import { ILogService } from '../../../log/common/log.js';
import { externalAgentLaunchEquals, providerIdForExternalAgent, type IExternalAgentCatalogue, type IExternalAgentEntry } from '../../common/externalAgentCatalogue.js';
import { AcpAgent } from './acpAgent.js';
import { ExternalAgentCatalogueService } from './externalAgentCatalogueService.js';

/** The subset of the agent service the registrar needs. */
export interface IAcpProviderRegistry {
	registerProvider(provider: AcpAgent): void;
	unregisterProvider(id: string): void;
}

/**
 * Keeps one {@link AcpAgent} provider registered per enabled catalogue
 * entry. Reacts to catalogue changes: new enabled entries register, disabled
 * or removed entries unregister, and an entry whose launch command changed
 * is re-registered so the next session uses the new command.
 */
export class AcpAgentRegistrar extends Disposable {

	private readonly _registered = new Map<string, { entry: IExternalAgentEntry; agent: AcpAgent }>();
	private _applying: Promise<void> = Promise.resolve();

	constructor(
		private readonly _registry: IAcpProviderRegistry,
		private readonly _catalogueService: ExternalAgentCatalogueService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._register(this._catalogueService.onDidChange(catalogue => this.apply(catalogue)));
	}

	get registeredIds(): readonly string[] {
		return [...this._registered.keys()];
	}

	/** Applies the catalogue; concurrent calls are serialized in order. */
	apply(catalogue: IExternalAgentCatalogue): Promise<void> {
		this._applying = this._applying.then(() => this._apply(catalogue)).catch(err => {
			this._logService.error('[ACP] failed to apply external agent catalogue', err);
		});
		return this._applying;
	}

	private async _apply(catalogue: IExternalAgentCatalogue): Promise<void> {
		if (this._store.isDisposed) {
			return;
		}
		const wanted = new Map<string, IExternalAgentEntry>();
		for (const entry of catalogue.agents) {
			if (catalogue.enabledIds.includes(entry.id)) {
				wanted.set(entry.id, entry);
			}
		}
		for (const [id, current] of [...this._registered]) {
			const next = wanted.get(id);
			if (!next || !externalAgentLaunchEquals(current.entry, next)) {
				this._unregister(id);
			} else {
				current.agent.updateEntry(next);
			}
		}
		for (const [id, entry] of wanted) {
			if (!this._registered.has(id)) {
				await this._registerEntry(entry);
			}
		}
	}

	private async _registerEntry(entry: IExternalAgentEntry): Promise<void> {
		const probe = await this._catalogueService.probe(entry);
		if (this._store.isDisposed || this._registered.has(entry.id)) {
			return;
		}
		const agent = this._instantiationService.createInstance(AcpAgent, entry, probe);
		try {
			this._registry.registerProvider(agent);
		} catch (err) {
			this._logService.error(`[ACP] could not register provider ${providerIdForExternalAgent(entry.id)}`, err);
			agent.dispose();
			return;
		}
		this._registered.set(entry.id, { entry, agent });
		this._logService.info(`[ACP] registered external agent ${entry.id} (${probe.ok ? 'ready' : probe.status})`);
	}

	private _unregister(id: string): void {
		const current = this._registered.get(id);
		if (!current) {
			return;
		}
		this._registered.delete(id);
		// The registry disposes the provider, which stops its live sessions.
		this._registry.unregisterProvider(current.agent.id);
		this._logService.info(`[ACP] unregistered external agent ${id}`);
	}

	override dispose(): void {
		for (const id of [...this._registered.keys()]) {
			this._unregister(id);
		}
		super.dispose();
	}
}

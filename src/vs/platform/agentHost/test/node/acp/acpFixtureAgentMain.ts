/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Test-only agent speaking the Agent Client Protocol over stdio. It is
 * spawned by the live-session tests with `process.execPath` and reacts to
 * the first text block of each prompt:
 *
 * - `echo <text>`   streams "echo: <text>" in two chunks, then end_turn
 * - `think`         streams a thought chunk then a message chunk
 * - `tool`          tool_call → session/request_permission → completed/failed
 * - `write <path>`  writes through fs/write_text_file, then reports
 * - `read <path>`   reads through fs/read_text_file and echoes the content
 * - `plan`          streams a plan, completes it, then end_turn
 * - `title <text>`  sends session_info_update with a new title
 * - `hang`          waits for session/cancel and answers `cancelled`
 * - `refuse`        answers with stopReason `refusal`
 * - `crash`         exits with code 7 mid-turn
 * - anything else   end_turn with no output
 *
 * Environment switches: `ACP_FIXTURE_AUTH=1` makes session/new demand
 * authentication; `ACP_FIXTURE_MODELS=1` exposes a model selector config
 * option; `ACP_FIXTURE_PROTOCOL=<n>` overrides the protocol version reported
 * by initialize; `ACP_FIXTURE_STARTUP=exit` exits before answering
 * initialize; `ACP_FIXTURE_STARTUP=hang` never answers initialize.
 */

import * as acp from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'stream';

interface IFixtureSession {
	abort: AbortController | undefined;
	modelId: string;
}

const sessions = new Map<string, IFixtureSession>();
let counter = 0;
let authenticated = false;

function modelOption(current: string): acp.SessionConfigOption {
	return {
		id: 'model',
		name: 'Model',
		category: 'model',
		type: 'select',
		currentValue: current,
		options: [{ value: 'fixture-small', name: 'Fixture Small' }, { value: 'fixture-large', name: 'Fixture Large' }],
	};
}

function configOptionsFor(session: IFixtureSession): acp.SessionConfigOption[] | undefined {
	return process.env.ACP_FIXTURE_MODELS === '1' ? [modelOption(session.modelId)] : undefined;
}

function firstText(prompt: readonly acp.ContentBlock[]): string {
	for (const block of prompt) {
		if (block.type === 'text') {
			return block.text;
		}
	}
	return '';
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error('aborted'));
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
	});
}

async function runPrompt(params: acp.PromptRequest, client: acp.AgentContext, signal: AbortSignal): Promise<acp.PromptResponse> {
	const sessionId = params.sessionId;
	const update = (u: acp.SessionUpdate) => client.notify('session/update', { sessionId, update: u });
	const text = firstText(params.prompt);
	const [verb, ...rest] = text.trim().split(/\s+/);
	const arg = rest.join(' ');

	switch (verb) {
		case 'context':
			await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(params.prompt) } });
			return { stopReason: 'end_turn' };
		case 'echo':
			await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'echo: ' } });
			await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: arg } });
			return { stopReason: 'end_turn' };
		case 'think':
			await update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'considering' } });
			await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'decided' } });
			return { stopReason: 'end_turn' };
		case 'tool': {
			const toolCallId = `call-${++counter}`;
			await update({ sessionUpdate: 'tool_call', toolCallId, title: 'Run fixture command', kind: 'execute', status: 'pending', rawInput: { command: 'fixture --run' } });
			const permission = await client.request('session/request_permission', {
				sessionId,
				toolCall: { toolCallId },
				options: [
					{ optionId: 'allow', name: 'Allow', kind: 'allow_once' },
					{ optionId: 'deny', name: 'Deny', kind: 'reject_once' },
				],
			});
			if (permission.outcome.outcome === 'selected' && permission.outcome.optionId === 'allow') {
				await update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress' });
				await update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'fixture output' } }] });
				await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ran' } });
			} else if (permission.outcome.outcome === 'selected') {
				await update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'failed', rawOutput: 'denied by user' });
				await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'skipped' } });
			} else {
				return { stopReason: 'cancelled' };
			}
			return { stopReason: 'end_turn' };
		}
		case 'write': {
			const toolCallId = `call-${++counter}`;
			await update({ sessionUpdate: 'tool_call', toolCallId, title: `Write ${arg}`, kind: 'edit', status: 'in_progress', locations: [{ path: arg }] });
			await client.request('fs/write_text_file', { sessionId, path: arg, content: 'written by fixture\n' });
			await update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' });
			await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'wrote' } });
			return { stopReason: 'end_turn' };
		}
		case 'read': {
			const result = await client.request('fs/read_text_file', { sessionId, path: arg, line: 2, limit: 1 });
			await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `line2=${result.content}` } });
			return { stopReason: 'end_turn' };
		}
		case 'plan':
			await update({ sessionUpdate: 'plan', entries: [{ content: 'first', priority: 'high', status: 'in_progress' }, { content: 'second', priority: 'low', status: 'pending' }] });
			await update({ sessionUpdate: 'plan', entries: [{ content: 'first', priority: 'high', status: 'completed' }, { content: 'second', priority: 'low', status: 'completed' }] });
			await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'planned' } });
			return { stopReason: 'end_turn' };
		case 'title':
			await update({ sessionUpdate: 'session_info_update', title: arg });
			return { stopReason: 'end_turn' };
		case 'hang':
			await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } });
			try {
				await sleep(60_000, signal);
			} catch {
				return { stopReason: 'cancelled' };
			}
			return { stopReason: 'end_turn' };
		case 'refuse':
			return { stopReason: 'refusal' };
		case 'crash':
			await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'about to crash' } });
			process.stderr.write('fixture: fatal error\n');
			process.exit(7);
		default:
			return { stopReason: 'end_turn' };
	}
}

function main(): void {
	const startup = process.env.ACP_FIXTURE_STARTUP;
	if (startup === 'exit') {
		process.stderr.write('fixture: refusing to start\n');
		process.exit(2);
	}
	const protocolVersion = process.env.ACP_FIXTURE_PROTOCOL ? Number(process.env.ACP_FIXTURE_PROTOCOL) : acp.PROTOCOL_VERSION;
	const stream = acp.ndJsonStream(
		Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
		Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
	);
	acp.agent({ name: 'fixture-agent' })
		.onRequest('initialize', async () => {
			if (startup === 'hang') {
				await new Promise<never>(() => { });
			}
			return {
				protocolVersion,
				agentInfo: { name: 'fixture-agent', version: '0.0.1' },
				agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: true } },
				authMethods: process.env.ACP_FIXTURE_AUTH === '1' ? [{ type: 'terminal', id: 'fixture-login', name: 'Fixture login', description: null }] : process.env.ACP_FIXTURE_AUTH === 'agent' ? [{ id: 'fixture-login', name: 'Fixture managed login' }] : [],
			};
		})
		.onRequest('authenticate', ({ params }) => {
			if (params.methodId !== 'fixture-login') { throw acp.RequestError.authRequired(); }
			authenticated = true;
			return {};
		})
		.onRequest('session/new', async ({ params, client }) => {
			if (process.env.ACP_FIXTURE_AUTH && !authenticated) {
				throw acp.RequestError.authRequired();
			}
			const sessionId = `fixture-session-${++counter}`;
			const session: IFixtureSession = { abort: undefined, modelId: 'fixture-small' };
			sessions.set(sessionId, session);
			await client.notify('session/update', { sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'inspect', description: 'Inspect a fixture', input: { hint: 'target' } }] } });
			if (process.env.ACP_FIXTURE_EXPECT_MCP === '1' && params.mcpServers[0]?.name !== 'v3code') { throw new Error('Missing supplied editor MCP server'); }
			process.stderr.write(`fixture: new session ${sessionId} in ${params.cwd}\n`);
			return { sessionId, configOptions: configOptionsFor(session) };
		})
		.onRequest('session/load', ({ params }) => {
			const session: IFixtureSession = { abort: undefined, modelId: 'fixture-small' };
			sessions.set(params.sessionId, session);
			return { configOptions: configOptionsFor(session) };
		})
		.onRequest('session/set_config_option', ({ params }) => {
			const session = sessions.get(params.sessionId);
			if (!session) {
				throw acp.RequestError.resourceNotFound(params.sessionId);
			}
			if (params.configId === 'model' && typeof params.value === 'string') {
				session.modelId = params.value;
			}
			return { configOptions: configOptionsFor(session) ?? [] };
		})
		.onRequest('session/prompt', async ({ params, client }) => {
			const session = sessions.get(params.sessionId);
			if (!session) {
				throw acp.RequestError.resourceNotFound(params.sessionId);
			}
			session.abort?.abort();
			session.abort = new AbortController();
			try {
				return await runPrompt(params, client, session.abort.signal);
			} finally {
				session.abort = undefined;
			}
		})
		.onNotification('session/cancel', ({ params }) => {
			sessions.get(params.sessionId)?.abort?.abort();
		})
		.connect(stream);
}

main();

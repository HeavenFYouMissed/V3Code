/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { dirname, joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { workspaceIdMarkerUri } from '../../common/contextBridge/memoryAddress.js';
import { resolveWorkspaceAddress } from '../../common/contextBridge/workspaceRegistry.js';

const USER_HOME = URI.file('/userdata').with({ scheme: Schemas.file });
const SENTINEL_NAME = 'shelving-gate-sentinel.txt';
const SENTINEL_BODY = 'memory-address-stable';

function setupFileService(disposables: Pick<DisposableStore, 'add'>): FileService {
	const logService = new NullLogService();
	const fileService = disposables.add(new FileService(logService));
	disposables.add(fileService.registerProvider(Schemas.file, disposables.add(new InMemoryFileSystemProvider())));
	return fileService;
}

async function readSentinelForWsId(
	fileService: FileService,
	userHome: URI,
	wsId: string,
): Promise<string> {
	const workspaceDir = joinPath(userHome, 'v3code-memory', 'profiles', 'default', 'workspace', wsId);
	const content = await fileService.readFile(joinPath(workspaceDir, SENTINEL_NAME));
	return content.value.toString();
}

async function carryMarkerTo(
	fileService: FileService,
	fromFolder: URI,
	toFolder: URI,
): Promise<void> {
	const fromMarker = workspaceIdMarkerUri(fromFolder);
	const toMarker = workspaceIdMarkerUri(toFolder);
	const markerBody = await fileService.readFile(fromMarker);
	await fileService.createFolder(dirname(toMarker));
	await fileService.writeFile(toMarker, markerBody.value);
}

suite('memoryLibrary / workspace address resolver (S6 gate)', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('(1) move to new parent re-finds wsId via marker; sentinel intact', async () => {
		const fileService = setupFileService(disposables);
		const pathA = URI.file('/projects/alpha/repo');
		const pathB = URI.file('/archive/2026/repo');

		const addressA = await resolveWorkspaceAddress(pathA, USER_HOME, fileService);
		await fileService.writeFile(
			joinPath(addressA.workspaceDir, SENTINEL_NAME),
			VSBuffer.fromString(SENTINEL_BODY),
		);

		await carryMarkerTo(fileService, pathA, pathB);

		const addressB = await resolveWorkspaceAddress(pathB, USER_HOME, fileService);
		assert.strictEqual(addressB.wsId, addressA.wsId, 'move must preserve wsId via marker');

		const sentinel = await readSentinelForWsId(fileService, USER_HOME, addressB.wsId);
		assert.strictEqual(sentinel, SENTINEL_BODY, 'sentinel must survive move');
	});

	test('(2) rename (same parent, new basename) re-finds wsId via marker', async () => {
		const fileService = setupFileService(disposables);
		const pathA = URI.file('/workspace/my-app');
		const pathA2 = URI.file('/workspace/my-app-renamed');

		const addressA = await resolveWorkspaceAddress(pathA, USER_HOME, fileService);
		await carryMarkerTo(fileService, pathA, pathA2);

		const addressA2 = await resolveWorkspaceAddress(pathA2, USER_HOME, fileService);
		assert.strictEqual(addressA2.wsId, addressA.wsId, 'rename must preserve wsId via marker');
	});

	test('(3) second workspace mints distinct wsId', async () => {
		const fileService = setupFileService(disposables);
		const pathA = URI.file('/clients/acme');
		const pathC = URI.file('/clients/beta');

		const addressA = await resolveWorkspaceAddress(pathA, USER_HOME, fileService);
		const addressC = await resolveWorkspaceAddress(pathC, USER_HOME, fileService);

		assert.notStrictEqual(addressC.wsId, addressA.wsId, 'distinct folders must not share wsId');
	});

	test('(4) moved/renamed repo never collapses to another workspace memory dir', async () => {
		const fileService = setupFileService(disposables);
		const pathA = URI.file('/team/frontend');
		const pathB = URI.file('/team/frontend-moved');
		const pathC = URI.file('/team/backend');

		const addressA = await resolveWorkspaceAddress(pathA, USER_HOME, fileService);
		const addressC = await resolveWorkspaceAddress(pathC, USER_HOME, fileService);
		await carryMarkerTo(fileService, pathA, pathB);

		const addressB = await resolveWorkspaceAddress(pathB, USER_HOME, fileService);

		assert.strictEqual(addressB.wsId, addressA.wsId, 'moved repo keeps its wsId');
		assert.notStrictEqual(addressB.wsId, addressC.wsId, 'must not resolve to another workspace wsId');
		assert.notStrictEqual(addressB.dbPath, addressC.dbPath, 'memory dirs must not collapse');
		assert.notStrictEqual(addressB.workspaceDir.toString(), addressC.workspaceDir.toString());
	});
});

/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { branchNameFromHead, repositoryLocatorFromGitConfig, repositoryLocatorFromRemoteUrl } from '../../common/cloudIndex/cloudIndexRepositoryIdentity.js';

suite('Cloud index repository identity', () => {
	test('normalizes HTTPS, SSH, nested GitLab and Azure remotes', () => {
		assert.strictEqual(repositoryLocatorFromRemoteUrl('https://github.com/Org/Repo.git'), 'github.com/org/repo');
		assert.strictEqual(repositoryLocatorFromRemoteUrl('git@github.com:Org/Repo.git'), 'github.com/org/repo');
		assert.strictEqual(repositoryLocatorFromRemoteUrl('ssh://git@gitlab.com/group/subgroup/repo.git'), 'gitlab.com/group/subgroup/repo');
		assert.strictEqual(repositoryLocatorFromRemoteUrl('https://dev.azure.com/Org/Project/_git/Repo'), 'dev.azure.com/org/project/_git/repo');
	});

	test('strips credentials locally and refuses filesystem remotes', () => {
		assert.strictEqual(repositoryLocatorFromRemoteUrl('https://user:secret@github.com/Org/Repo.git'), 'github.com/org/repo');
		assert.strictEqual(repositoryLocatorFromRemoteUrl('/Users/person/private-repo'), undefined);
		assert.strictEqual(repositoryLocatorFromRemoteUrl('../private-repo'), undefined);
	});

	test('prefers origin, then upstream, then any usable remote', () => {
		const config = `
[remote "backup"]
  url = https://github.com/other/backup.git
[remote "upstream"]
  url = https://github.com/upstream/project.git
[remote "origin"]
  url = git@github.com:company/product.git
`;
		assert.strictEqual(repositoryLocatorFromGitConfig(config), 'github.com/company/product');
	});

	test('reads symbolic branches but refuses detached or unsafe HEAD values', () => {
		assert.strictEqual(branchNameFromHead('ref: refs/heads/feature/team-index\n'), 'feature/team-index');
		assert.strictEqual(branchNameFromHead('9d181c5132d63e095f098ec0d3563b9232ab9318'), undefined);
		assert.strictEqual(branchNameFromHead('ref: refs/heads/../escape'), undefined);
	});
});

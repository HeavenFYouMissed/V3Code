/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
/*--------------------------------------------------------------------------------------
 *  Re-export VS Code / void modules at the depth tsup expects for the settings bundle.
 *  Tab files live one folder deeper — if they import ../../../../../common directly,
 *  those strings are left external and fail at runtime (ERR_FILE_NOT_FOUND / grey screen).
 *  Tabs must import ONLY from this file (or other ./ siblings like settingsShared).
 *--------------------------------------------------------------------------------------*/

export {
	displayInfoOfFeatureName,
	displayInfoOfProviderName,
	refreshableProviderNames,
	localProviderNames,
	nonlocalProviderNames,
} from '../../../../common/voidSettingsTypes.js';

export type {
	ImageDescribeMode,
	PromptAssemblyPresetSetting,
} from '../../../../common/voidSettingsTypes.js';

export { getModelCapabilities } from '../../../../common/modelCapabilities.js';
export { v3ChromeAvatarUrl, externalAgentMarkUrls } from '../../../v3BrandAssets.js';

export {
	VOID_TURBO_DRAFT_ACTION_ID,
	VOID_TURBO_DRAFT_ACCEPT_HUNK_ACTION_ID,
	VOID_TURBO_DRAFT_DEEP_ACTION_ID,
	VOID_TURBO_DRAFT_DEEP_MULTI_FILE_ACTION_ID,
	VOID_TURBO_DRAFT_DISCARD_ACTION_ID,
	VOID_TURBO_DRAFT_REJECT_HUNK_ACTION_ID,
} from '../../../actionIDs.js';

export { toolApprovalTypes } from '../../../../common/toolsServiceTypes.js';
export type { ToolApprovalType } from '../../../../common/toolsServiceTypes.js';

export { isMcpServerConnected, isMcpServerUsable } from '../../../../common/mcpServiceTypes.js';
export type { MCPServer } from '../../../../common/mcpServiceTypes.js';

export {
	CATALOG,
	CATALOG_CATEGORY_FILTERS,
	BRAND_ICON_PATHS,
	brandIconSvg,
	monogramOf,
	catalogEntryForServerName,
	isRemoteEntry,
	findUnresolvedVariables,
	configEntryStrings,
	installEntryForCatalogEntry,
	primaryActionFor,
	recoveryActionFor,
	humanizeError,
	classifyGalleryServer,
	galleryServerToCatalogEntry,
} from '../../../../common/mcpCatalog.js';
export type {
	CatalogEntry,
	CatalogEntryKind,
	CatalogAuthHint,
	CatalogInput,
	CatalogCategory,
	CatalogPrimaryAction,
	CatalogRecoveryAction,
	GalleryServerLike,
} from '../../../../common/mcpCatalog.js';

export type { IV3CodeBroadcast, IV3CodeStatusBoard } from '../../../../common/v3codeBroadcast.js';

export {
	buildV3codeMcpClientConfig,
	buildV3codeMcpStdioClientConfig,
	buildV3codeClaudeCodeConfig,
	V3CODE_MCP_EXPOSE_CHANNEL,
} from '../../../../common/mcpExpose/mcpExposeTypes.js';
export type {
	McpInstanceDescriptor,
	V3codeMcpClientSetupResult,
	V3codeMcpExtensionResult,
	V3codeMcpInstallResult,
} from '../../../../common/mcpExpose/mcpExposeTypes.js';

export { OPT_OUT_KEY } from '../../../../common/storageKeys.js';

export {
	v3codeMessagePrefKeys,
	displayInfoOfMessagePref,
} from '../../../../common/v3codeAccountService.js';

export { URI } from '../../../../../../../base/common/uri.js';
export { default as Severity } from '../../../../../../../base/common/severity.js';
export { StorageScope, StorageTarget } from '../../../../../../../platform/storage/common/storage.js';
export { ConfigurationTarget } from '../../../../../../../platform/configuration/common/configuration.js';

export { OFFICIAL_ACP_REGISTRY_URL } from '../../../../common/externalAgentsService.js';
export type { IExternalAgentsState, IExternalAgentHostStatus, IExternalAgentCustomInput } from '../../../../common/externalAgentsService.js';
export { describeExternalAgentLaunch, resolveExternalAgentLaunch } from '../../../../../../../platform/agentHost/common/externalAgentCatalogue.js';
export type { IExternalAgentEntry, IExternalAgentCatalogue } from '../../../../../../../platform/agentHost/common/externalAgentCatalogue.js';

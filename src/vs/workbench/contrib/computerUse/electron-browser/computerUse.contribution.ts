/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Single entry point for the computer-use contribution, mirroring
 * `contrib/browserView/electron-browser/browserView.contribution.ts`.
 *
 * Every module below is imported for its side effect: each one calls `registerSingleton` or
 * `registerWorkbenchContribution2` at module scope, and those calls only run if the module is
 * actually pulled into the bundle.
 *
 * This matters more than it looks. A service's `createDecorator` and its `registerSingleton` do not
 * have to live in the same file — `IComputerUseConsentService` is declared in
 * `common/computerUseConsent.ts` but registered in `electron-browser/computerUseConsentService.ts`.
 * Importing only the decorator type-checks perfectly and then fails at runtime with a "no service"
 * error the moment something injects it, because the registration side never executed. Importing the
 * implementation modules explicitly here is what prevents that.
 */

// Services. Order is irrelevant — registration is lazy — but each import must be present.
import '../browser/computerUseExclusionStore.js';
import './computerUseConsentService.js';
import '../browser/computerUseService.js';

// Ambient observation (tier 5). `IComputerUseObservationConsentService` is the exact split this file's
// header warns about: its decorator is declared in `browser/computerUseObservationService.ts` — where
// `browser` may not import `electron-browser` — while its implementation and `registerSingleton` live in
// `electron-browser/computerUseObservationConsent.js`. Without the second import below, injecting it
// type-checks and then throws "no service" the first time observation is asked for.
import '../browser/computerUseObservationStore.js';
import './computerUseObservationConsent.js';
import '../browser/computerUseObservationService.js';

// Tools + the workbench contribution that registers the ToolSet.
import './computerUseTools.contribution.js';

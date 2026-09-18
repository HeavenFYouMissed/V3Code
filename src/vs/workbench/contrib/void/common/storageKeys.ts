/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// past values:
// 'void.settingsServiceStorage'
// 'void.settingsServiceStorageI' // 1.0.2

// 1.0.3
export const VOID_SETTINGS_STORAGE_KEY = 'void.settingsServiceStorageII'


// past values:
// 'void.chatThreadStorage'
// 'void.chatThreadStorageI' // 1.0.2

// 1.0.3
export const THREAD_STORAGE_KEY = 'void.chatThreadStorageII'



export const OPT_OUT_KEY = 'void.app.optOutAll'

/**
 * Broadcast notifications (v3codeBroadcastService): ids of feed items this machine has already
 * shown, so a broadcast is presented once and never re-nags across restarts. JSON string[],
 * capped — APPLICATION scope / MACHINE target.
 */
export const SEEN_BROADCASTS_KEY = 'v3code.broadcasts.seenIds'

/** Anonymous, machine-local identifier used only to make a product vote replaceable. */
export const PRODUCT_VOTE_INSTALL_ID_KEY = 'v3code.feedback.productVoteInstallId'


/**
 * Onboarding completion, mirrored OUTSIDE the encrypted settings blob. The blob is the source of
 * truth for settings, but both of its parse paths fall back to defaultState() on any error, which
 * flips isOnboardingComplete back to false and re-shows the full-screen overlay to a user who
 * finished onboarding months ago. This plain boolean survives that fallback, and the overlay is
 * suppressed if EITHER says complete.
 */
export const ONBOARDING_COMPLETE_KEY = 'v3code.onboardingComplete'

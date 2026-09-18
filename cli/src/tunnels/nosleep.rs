/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

#[cfg(target_os = "windows")]
pub type SleepInhibitor = super::nosleep_windows::SleepInhibitor;

#[cfg(target_os = "linux")]
pub type SleepInhibitor = super::nosleep_linux::SleepInhibitor;

#[cfg(target_os = "macos")]
pub type SleepInhibitor = super::nosleep_macos::SleepInhibitor;

/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/** @type {import('tailwindcss').Config} */
module.exports = {
	darkMode: 'selector', // '{prefix-}dark' className is used to identify `dark:`
	content: ['./src2/**/*.{jsx,tsx}'], // uses these files to decide how to transform the css file
	theme: {
		extend: {
			typography: theme => ({
				DEFAULT: {
					css: {
						'--tw-prose-body': 'var(--void-fg-1)',
						'--tw-prose-headings': 'var(--void-fg-1)',
						'--tw-prose-lead': 'var(--void-fg-2)',
						'--tw-prose-links': 'var(--void-link-color)',
						'--tw-prose-bold': 'var(--void-fg-1)',
						'--tw-prose-counters': 'var(--void-fg-3)',
						'--tw-prose-bullets': 'var(--void-fg-3)',
						'--tw-prose-hr': 'var(--void-border-4)',
						'--tw-prose-quotes': 'var(--void-fg-1)',
						'--tw-prose-quote-borders': 'var(--void-border-2)',
						'--tw-prose-captions': 'var(--void-fg-3)',
						'--tw-prose-code': 'var(--void-fg-0)',
						'--tw-prose-pre-code': 'var(--void-fg-0)',
						'--tw-prose-pre-bg': 'var(--void-bg-1)',
						'--tw-prose-th-borders': 'var(--void-border-4)',
						'--tw-prose-td-borders': 'var(--void-border-4)',
					},
				},
			}),
			fontSize: {
				xs: '10px',
				sm: '11px',
				root: '13px',
				lg: '14px',
				xl: '16px',
				'2xl': '18px',
				'3xl': '20px',
				'4xl': '24px',
				'5xl': '30px',
				'6xl': '36px',
				'7xl': '48px',
				'8xl': '64px',
				'9xl': '72px',
			},
			// common colors to use, ordered light to dark

			colors: {
				'void-bg-1': 'var(--void-bg-1)',
				'void-bg-1-alt': 'var(--void-bg-1-alt)',
				'void-bg-2': 'var(--void-bg-2)',
				'void-bg-2-alt': 'var(--void-bg-2-alt)',
				'void-bg-2-hover': 'var(--void-bg-2-hover)',
				'void-bg-3': 'var(--void-bg-3)',


				'void-fg-0': 'var(--void-fg-0)',
				'void-fg-1': 'var(--void-fg-1)',
				'void-fg-2': 'var(--void-fg-2)',
				'void-fg-3': 'var(--void-fg-3)',
				// 'void-fg-4': 'var(--vscode-tab-inactiveForeground)',
				'void-fg-4': 'var(--void-fg-4)',

				'void-warning': 'var(--void-warning)',

				'void-border-1': 'var(--void-border-1)',
				'void-border-2': 'var(--void-border-2)',
				'void-border-3': 'var(--void-border-3)',
				'void-border-4': 'var(--void-border-4)',

				'void-ring-color': 'var(--void-ring-color)',
				'void-link-color': 'var(--void-link-color)',

				// V3Code brand palette — see V3CODE-BRANDING.md.
				// Use these when a component needs an explicit brand color
				// (amethyst on AI messages, venom for memory indicators).
				// Most surfaces auto-inherit the brand via the --void-* overrides
				// in styles.css and don't need to reference v3- tokens directly.
				'v3-abyss': 'var(--v3-abyss)',
				'v3-void': 'var(--v3-void-bg)',
				'v3-obsidian': 'var(--v3-obsidian)',
				'v3-slate': 'var(--v3-slate)',
				'v3-ash': 'var(--v3-ash)',
				'v3-smoke': 'var(--v3-smoke)',

				'v3-amethyst': 'var(--v3-amethyst)',
				'v3-amethyst-glow': 'var(--v3-amethyst-glow)',
				'v3-amethyst-deep': 'var(--v3-amethyst-deep)',
				'v3-amethyst-muted': 'var(--v3-amethyst-muted)',
				'v3-amethyst-wash': 'var(--v3-amethyst-wash)',

				'v3-venom': 'var(--v3-venom)',
				'v3-venom-bright': 'var(--v3-venom-bright)',
				'v3-venom-muted': 'var(--v3-venom-muted)',
				'v3-venom-deep': 'var(--v3-venom-deep)',

				'v3-error': 'var(--v3-error)',
				'v3-warning': 'var(--v3-warning)',
				'v3-info': 'var(--v3-info)',
				'v3-success': 'var(--v3-success)',

				'v3-text-primary': 'var(--v3-text-primary)',
				'v3-text-secondary': 'var(--v3-text-secondary)',
				'v3-text-tertiary': 'var(--v3-text-tertiary)',
				'v3-text-bright': 'var(--v3-text-bright)',

				vscode: {
					// see: https://code.visualstudio.com/api/extension-guides/webview#theming-webview-content

					// base colors
					'fg': 'var(--vscode-foreground)',
					'focus-border': 'var(--vscode-focusBorder)',
					'disabled-fg': 'var(--vscode-disabledForeground)',
					'widget-border': 'var(--vscode-widget-border)',
					'widget-shadow': 'var(--vscode-widget-shadow)',
					'selection-bg': 'var(--vscode-selection-background)',
					'description-fg': 'var(--vscode-descriptionForeground)',
					'error-fg': 'var(--vscode-errorForeground)',
					'icon-fg': 'var(--vscode-icon-foreground)',
					'sash-hover-border': 'var(--vscode-sash-hoverBorder)',

					// text colors
					'text-blockquote-bg': 'var(--vscode-textBlockQuote-background)',
					'text-blockquote-border': 'var(--vscode-textBlockQuote-border)',
					'text-codeblock-bg': 'var(--vscode-textCodeBlock-background)',
					'text-link-active-fg': 'var(--vscode-textLink-activeForeground)',
					'text-link-fg': 'var(--vscode-textLink-foreground)',
					'text-preformat-fg': 'var(--vscode-textPreformat-foreground)',
					'text-preformat-bg': 'var(--vscode-textPreformat-background)',
					'text-separator-fg': 'var(--vscode-textSeparator-foreground)',

					// input colors
					'input-bg': 'var(--vscode-input-background)',
					'input-border': 'var(--vscode-input-border)',
					'input-fg': 'var(--vscode-input-foreground)',
					'input-placeholder-fg': 'var(--vscode-input-placeholderForeground)',
					'input-active-bg': 'var(--vscode-input-activeBackground)',
					'input-option-active-border': 'var(--vscode-inputOption-activeBorder)',
					'input-option-active-fg': 'var(--vscode-inputOption-activeForeground)',
					'input-option-hover-bg': 'var(--vscode-inputOption-hoverBackground)',
					'input-validation-error-bg': 'var(--vscode-inputValidation-errorBackground)',
					'input-validation-error-fg': 'var(--vscode-inputValidation-errorForeground)',
					'input-validation-error-border': 'var(--vscode-inputValidation-errorBorder)',
					'input-validation-info-bg': 'var(--vscode-inputValidation-infoBackground)',
					'input-validation-info-fg': 'var(--vscode-inputValidation-infoForeground)',
					'input-validation-info-border': 'var(--vscode-inputValidation-infoBorder)',
					'input-validation-warning-bg': 'var(--vscode-inputValidation-warningBackground)',
					'input-validation-warning-fg': 'var(--vscode-inputValidation-warningForeground)',
					'input-validation-warning-border': 'var(--vscode-inputValidation-warningBorder)',

					// command center colors (the top bar)
					'commandcenter-fg': 'var(--vscode-commandCenter-foreground)',
					'commandcenter-active-fg': 'var(--vscode-commandCenter-activeForeground)',
					'commandcenter-bg': 'var(--vscode-commandCenter-background)',
					'commandcenter-active-bg': 'var(--vscode-commandCenter-activeBackground)',
					'commandcenter-border': 'var(--vscode-commandCenter-border)',
					'commandcenter-inactive-fg': 'var(--vscode-commandCenter-inactiveForeground)',
					'commandcenter-inactive-border': 'var(--vscode-commandCenter-inactiveBorder)',
					'commandcenter-active-border': 'var(--vscode-commandCenter-activeBorder)',
					'commandcenter-debugging-bg': 'var(--vscode-commandCenter-debuggingBackground)',

					// badge colors
					'badge-fg': 'var(--vscode-badge-foreground)',
					'badge-bg': 'var(--vscode-badge-background)',

					// button colors
					'button-bg': 'var(--vscode-button-background)',
					'button-fg': 'var(--vscode-button-foreground)',
					'button-border': 'var(--vscode-button-border)',
					'button-separator': 'var(--vscode-button-separator)',
					'button-hover-bg': 'var(--vscode-button-hoverBackground)',
					'button-secondary-fg': 'var(--vscode-button-secondaryForeground)',
					'button-secondary-bg': 'var(--vscode-button-secondaryBackground)',
					'button-secondary-hover-bg': 'var(--vscode-button-secondaryHoverBackground)',

					// checkbox colors
					'checkbox-bg': 'var(--vscode-checkbox-background)',
					'checkbox-fg': 'var(--vscode-checkbox-foreground)',
					'checkbox-border': 'var(--vscode-checkbox-border)',
					'checkbox-select-bg': 'var(--vscode-checkbox-selectBackground)',

					// sidebar colors
					'sidebar-bg': 'var(--vscode-sideBar-background)',
					'sidebar-fg': 'var(--vscode-sideBar-foreground)',
					'sidebar-border': 'var(--vscode-sideBar-border)',
					'sidebar-drop-bg': 'var(--vscode-sideBar-dropBackground)',
					'sidebar-title-fg': 'var(--vscode-sideBarTitle-foreground)',
					'sidebar-header-bg': 'var(--vscode-sideBarSectionHeader-background)',
					'sidebar-header-fg': 'var(--vscode-sideBarSectionHeader-foreground)',
					'sidebar-header-border': 'var(--vscode-sideBarSectionHeader-border)',
					'sidebar-activitybartop-border': 'var(--vscode-sideBarActivityBarTop-border)',
					'sidebar-title-bg': 'var(--vscode-sideBarTitle-background)',
					'sidebar-title-border': 'var(--vscode-sideBarTitle-border)',
					'sidebar-stickyscroll-bg': 'var(--vscode-sideBarStickyScroll-background)',
					'sidebar-stickyscroll-border': 'var(--vscode-sideBarStickyScroll-border)',
					'sidebar-stickyscroll-shadow': 'var(--vscode-sideBarStickyScroll-shadow)',

					// other colors (these are partially complete)

					// text formatting
					'text-preformat-bg': 'var(--vscode-textPreformat-background)',
					'text-preformat-fg': 'var(--vscode-textPreformat-foreground)',

					// editor colors
					'editor-bg': 'var(--vscode-editor-background)',
					'editor-fg': 'var(--vscode-editor-foreground)',



					// other
					'editorwidget-bg': 'var(--vscode-editorWidget-background)',
					'toolbar-hover-bg': 'var(--vscode-toolbar-hoverBackground)',
					'toolbar-foreground': 'var(--vscode-editorActionList-foreground)',

					'editorwidget-fg': 'var(--vscode-editorWidget-foreground)',
					'editorwidget-border': 'var(--vscode-editorWidget-border)',

					'charts-orange': 'var(--vscode-charts-orange)',
					'charts-yellow': 'var(--vscode-charts-yellow)',
				},
			},
		},
	},
	plugins: [
		require('@tailwindcss/typography')
	],
	prefix: 'void-'
}


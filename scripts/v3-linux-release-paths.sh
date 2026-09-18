#!/usr/bin/env bash
# Path guard shared by the Linux release packager and its focused tests.
# The caller must enable its own shell safety options.

v3_linux_realpath() {
	python3 - "$1" <<'PY'
import os
import sys

print(os.path.realpath(os.path.abspath(sys.argv[1])))
PY
}

v3_linux_release_paths() {
	if [ "$#" -ne 4 ]; then
		echo "v3-package-linux: internal path guard requires repo, requested root, arch, and commit." >&2
		return 2
	fi
	if ! command -v python3 >/dev/null 2>&1; then
		echo "v3-package-linux: python3 is required to validate release paths safely." >&2
		return 1
	fi

	local repo_root requested_root arch commit safe_releases_root home_root release_root raw_tree tree_dir
	repo_root="$(v3_linux_realpath "$1")"
	requested_root="$2"
	arch="$3"
	commit="$4"
	safe_releases_root="$(v3_linux_realpath "$repo_root/.build/releases")"
	home_root=""
	if [ -n "${HOME:-}" ]; then
		home_root="$(v3_linux_realpath "$HOME")"
	fi

	case "$safe_releases_root" in
		""|/|"$repo_root"|"$home_root")
			echo "v3-package-linux: the validated release base is unsafe: '$safe_releases_root'." >&2
			return 1
			;;
	esac

	if [ -z "$requested_root" ]; then
		requested_root="$safe_releases_root/$commit"
	else
		case "$requested_root" in
			/*) ;;
			*) requested_root="$repo_root/$requested_root" ;;
		esac
	fi
	if [ -L "$requested_root" ]; then
		echo "v3-package-linux: --release-root cannot be a symbolic link: '$requested_root'." >&2
		return 1
	fi
	release_root="$(v3_linux_realpath "$requested_root")"

	case "$release_root" in
		""|/|"$repo_root"|"$safe_releases_root"|"$home_root")
			echo "v3-package-linux: refusing unsafe release root '$release_root'." >&2
			return 1
			;;
	esac
	case "$release_root" in
		"$safe_releases_root"/*) ;;
		*)
			echo "v3-package-linux: --release-root must be a child of '$safe_releases_root' (got '$release_root')." >&2
			return 1
			;;
	esac

	raw_tree="$release_root/VSCode-linux-$arch"
	if [ -L "$raw_tree" ]; then
		echo "v3-package-linux: package tree cannot be a symbolic link: '$raw_tree'." >&2
		return 1
	fi
	tree_dir="$(v3_linux_realpath "$raw_tree")"
	if [ -z "$tree_dir" ] || [ "$tree_dir" = / ] || [ "$tree_dir" = "$repo_root" ]; then
		echo "v3-package-linux: refusing unsafe package tree '$tree_dir'." >&2
		return 1
	fi
	if [ -n "$home_root" ] && [ "$tree_dir" = "$home_root" ]; then
		echo "v3-package-linux: refusing unsafe package tree '$tree_dir'." >&2
		return 1
	fi
	if [ "$(basename -- "$tree_dir")" != "VSCode-linux-$arch" ] || [ "$(dirname -- "$tree_dir")" != "$release_root" ]; then
		echo "v3-package-linux: package tree must be exactly '$release_root/VSCode-linux-$arch' (got '$tree_dir')." >&2
		return 1
	fi
	case "$tree_dir" in
		"$safe_releases_root"/*/VSCode-linux-"$arch") ;;
		*)
			echo "v3-package-linux: package tree escaped the validated release base: '$tree_dir'." >&2
			return 1
			;;
	esac

	V3_LINUX_SAFE_RELEASES_ROOT="$safe_releases_root"
	RELEASE_ROOT="$release_root"
	TREE_DIR="$tree_dir"
}

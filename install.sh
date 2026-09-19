#!/bin/sh
set -eu

repository="bhujelaayushgc/localdesk"
install_dir=${LOCALDESK_INSTALL_DIR:-"${HOME:?HOME is not set}/.local/bin"}
version=${LOCALDESK_VERSION:-}
release_url=${LOCALDESK_RELEASE_URL:-}
temporary=""
staged=""

fail() {
	printf 'LocalDesk installer: %s\n' "$*" >&2
	exit 1
}

cleanup() {
	[ -z "$staged" ] || rm -f "$staged"
	[ -z "$temporary" ] || rm -rf "$temporary"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"

case $(uname -s) in
	Darwin) os=darwin ;;
	Linux) os=linux ;;
	*) fail "unsupported operating system: $(uname -s)" ;;
esac

case $(uname -m) in
	x86_64 | amd64) arch=amd64 ;;
	arm64 | aarch64) arch=arm64 ;;
	*) fail "unsupported architecture: $(uname -m)" ;;
esac

case "$install_dir" in
	/*) ;;
	*) fail "LOCALDESK_INSTALL_DIR must be an absolute path" ;;
esac

if [ -z "$release_url" ]; then
	if [ -z "$version" ]; then
		release_url="https://github.com/$repository/releases/latest/download"
	else
		case "$version" in
			*[!A-Za-z0-9._-]*) fail "invalid LOCALDESK_VERSION: $version" ;;
		esac
		case "$version" in
			v[0-9]*) ;;
			[0-9]*) version="v$version" ;;
			*) fail "LOCALDESK_VERSION must be a release such as v0.1.0" ;;
		esac
		release_url="https://github.com/$repository/releases/download/$version"
	fi
fi
release_url=${release_url%/}

temporary=$(mktemp -d "${TMPDIR:-/tmp}/localdesk-install.XXXXXX") || fail "could not create a temporary directory"
archive="localdesk-$os-$arch.tar.gz"

printf 'Downloading %s...\n' "$archive"
curl -fsSL --retry 3 --retry-connrefused "$release_url/$archive" -o "$temporary/$archive" || fail "could not download $archive"
curl -fsSL --retry 3 --retry-connrefused "$release_url/checksums.txt" -o "$temporary/checksums.txt" || fail "could not download checksums.txt"

expected=$(awk -v asset="$archive" '
{
	name = $2
	sub(/^\*/, "", name)
	sub(/^\.\//, "", name)
	if (name == asset) {
		print $1
		exit
	}
}' "$temporary/checksums.txt")
[ ${#expected} -eq 64 ] || fail "checksums.txt does not contain $archive"

if command -v sha256sum >/dev/null 2>&1; then
	actual=$(sha256sum "$temporary/$archive" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
	actual=$(shasum -a 256 "$temporary/$archive" | awk '{print $1}')
else
	fail "sha256sum or shasum is required"
fi
[ "$actual" = "$expected" ] || fail "checksum verification failed for $archive"

binary="localdesk-$os-$arch"
tar -xzf "$temporary/$archive" -C "$temporary" "$binary" || fail "could not extract $archive"
[ -f "$temporary/$binary" ] || fail "$archive does not contain $binary"

mkdir -p "$install_dir" || fail "could not create $install_dir"
[ -d "$install_dir" ] || fail "install destination is not a directory: $install_dir"
target="$install_dir/localdesk"
[ ! -d "$target" ] || fail "install target is a directory: $target"
staged="$install_dir/.localdesk-install.$$"
cp "$temporary/$binary" "$staged" || fail "could not write to $install_dir"
chmod 0755 "$staged" || fail "could not make the installed binary executable"
mv -f "$staged" "$target" || fail "could not replace $target"
staged=""

installed_version=$("$target" --version 2>/dev/null || true)
printf 'Installed %s at %s\n' "${installed_version:-LocalDesk}" "$target"
case ":${PATH:-}:" in
	*":$install_dir:"*) printf 'Run: localdesk\n' ;;
	*) printf 'Add %s to PATH, then run: localdesk\n' "$install_dir" ;;
esac

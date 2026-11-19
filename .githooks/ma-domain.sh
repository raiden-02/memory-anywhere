# shellcheck shell=sh
# Sourced by pre-commit and commit-msg. Sets $ma_domain to the owner's private hostname
# (MA_DOMAIN), or to nothing for a contributor who has none. The value is never printed.
ma_domain="${MA_DOMAIN:-}"
if [ -z "$ma_domain" ] && command -v powershell.exe >/dev/null 2>&1; then
  # setx writes the user environment, which processes started earlier do not see.
  ma_domain="$(powershell.exe -NoProfile -NonInteractive -Command "[Environment]::GetEnvironmentVariable('MA_DOMAIN','User')" | tr -d '\r\n')"
fi
export MA_DOMAIN="$ma_domain"

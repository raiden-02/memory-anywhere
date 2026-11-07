# Sourced by pre-commit and commit-msg. Sets $ma_domain to the owner's private
# hostname (MA_DOMAIN) or exits non-zero. The value is never printed.
ma_domain="${MA_DOMAIN:-}"
if [ -z "$ma_domain" ] && command -v powershell.exe >/dev/null 2>&1; then
  # setx writes the user environment, which processes started earlier do not see.
  ma_domain="$(powershell.exe -NoProfile -NonInteractive -Command "[Environment]::GetEnvironmentVariable('MA_DOMAIN','User')" | tr -d '\r\n')"
fi
if [ -z "$ma_domain" ]; then
  echo "memory-anywhere guard: MA_DOMAIN is not set, so the owner-domain check cannot run. Set it and retry." >&2
  exit 1
fi

# Atelier shell integration for bash (Linux, Git Bash, WSL). Loaded with `bash --rcfile <this> -i`.
# Powerline prompt ported from RDMan's SSH session prompt. Nothing here is written to disk outside Atelier.

if [ -n "$ATELIER_LOGIN" ]; then
  # Git Bash and WSL normally start a login shell: load what it would.
  [ -r /etc/profile ] && . /etc/profile
  if [ -r ~/.bash_profile ]; then . ~/.bash_profile
  elif [ -r ~/.bash_login ]; then . ~/.bash_login
  elif [ -r ~/.profile ]; then . ~/.profile
  elif [ -r ~/.bashrc ]; then . ~/.bashrc
  fi
else
  [ -r /etc/bash.bashrc ] && . /etc/bash.bashrc
  [ -r ~/.bashrc ] && . ~/.bashrc
fi
unset ATELIER_LOGIN

# The directory Atelier asked for (a login profile may `cd ~`).
if [ -n "$ATELIER_CWD" ]; then builtin cd -- "$ATELIER_CWD" 2>/dev/null; unset ATELIER_CWD; fi

__atelier_arrow=$'\xee\x82\xb0'
__atelier_thin=$'\xee\x82\xb1'
__atelier_branch=$'\xee\x82\xa0'
__atelier_cross=$'\xe2\x9c\x98'
__atelier_clock=$'\xef\x80\x97'
__atelier_more=$'\xe2\x80\xa6'
__atelier_user=${USER:-${USERNAME:-$(id -un 2>/dev/null)}}
__atelier_host=${HOSTNAME:-$(hostname 2>/dev/null)}
__atelier_host=${__atelier_host%%.*}
__atelier_start=
__atelier_none= # must be set: bash skips the PS0 offset arithmetic of an unset variable
VIRTUAL_ENV_DISABLE_PROMPT=1

# OSC 7 needs a URL: percent-encode everything but unreserved characters and '/'.
__atelier_urlencode() {
  local LC_ALL=C s=$1 i c out=
  for ((i = 0; i < ${#s}; i++)); do
    c=${s:i:1}
    case $c in [A-Za-z0-9/._~-]) out+=$c ;; *) printf -v c '%%%02X' "'$c"; out+=$c ;; esac
  done
  __atelier_url=$out
}

# Colors are ANSI indices 0-15 so the prompt follows the terminal's scheme. \001 \002 tell readline which bytes
# take no space; they work inside an expanded variable, which keeps folder and branch names out of prompt
# expansion (a folder called $(...) is shown, never run).
__atelier_sgr() { printf -v __atelier_tmp '\001\033[%sm\002' "$1"; __atelier_ps+=$__atelier_tmp; }

__atelier_seg() { # bg fg text
  local bg=$((40 + $1 % 8 + ($1 > 7 ? 60 : 0))) fg=$((30 + $2 % 8 + ($2 > 7 ? 60 : 0)))
  if [ -n "$__atelier_bg" ]; then
    __atelier_sgr "$((30 + __atelier_bg % 8 + (__atelier_bg > 7 ? 60 : 0)));$bg"
    __atelier_ps+=$__atelier_arrow
  fi
  __atelier_sgr "$fg;$bg"
  __atelier_ps+=" $3 "
  __atelier_bg=$1
}

__atelier_git() { # sets __atelier_br and __atelier_dirty with a single git call
  __atelier_br= __atelier_dirty=
  command -v git >/dev/null 2>&1 || return
  local st line oid=
  st=$(git --no-optional-locks status --porcelain=v2 --branch --untracked-files=no 2>/dev/null) || return
  while IFS= read -r line; do
    case $line in
      '# branch.head '*) __atelier_br=${line#'# branch.head '} ;;
      '# branch.oid '*) oid=${line#'# branch.oid '} ;;
      '#'*) ;;
      ?*) __atelier_dirty=1 ;;
    esac
  done <<< "$st"
  [ "$__atelier_br" = "(detached)" ] && __atelier_br=${oid:0:7}
}

__atelier_prompt() {
  local ec=$? elapsed=
  if [ -n "$__atelier_start" ]; then elapsed=$((SECONDS - __atelier_start)); fi
  __atelier_start=
  if [ "$PWD" != "$__atelier_lastpwd" ]; then
    __atelier_lastpwd=$PWD
    # Git Bash: report the Windows path (/tmp is %TEMP%, / is Git's folder…); only when the directory changed.
    if [ -n "$MSYSTEM" ]; then __atelier_urlencode "/$(builtin pwd -W)"; else __atelier_urlencode "$PWD"; fi
  fi
  printf '\033]133;D;%s\007\033]7;file://%s%s\007\033]133;A\007' "$ec" "$__atelier_host" "$__atelier_url"

  if [ -z "$ATELIER_POWERLINE" ]; then return $ec; fi

  __atelier_ps=
  __atelier_bg=
  if [ "$EUID" = 0 ]; then __atelier_seg 1 15 "$__atelier_user"; else __atelier_seg 8 15 "$__atelier_user"; fi
  __atelier_seg 0 7 "$__atelier_host"
  [ -n "$VIRTUAL_ENV" ] && __atelier_seg 6 0 "${VIRTUAL_ENV##*/}"

  local p=$PWD h=$HOME rest=
  if [ -n "$MSYSTEM" ]; then p=${p,,}; h=${h,,}; fi # Windows paths are case-insensitive
  if [ "$p" = "$h" ]; then __atelier_seg 4 0 "~"
  elif [ -n "$h" ] && [ "${p#"$h"/}" != "$p" ]; then __atelier_seg 4 0 "~"; rest=${PWD:${#h}+1}
  else __atelier_seg 4 0 "/"; rest=${PWD#/}
  fi
  if [ -n "$rest" ]; then
    local parts=() part joined=
    IFS=/ read -r -a parts <<< "$rest"
    if [ "${#parts[@]}" -gt 3 ]; then parts=("$__atelier_more" "${parts[@]: -2}"); fi
    for part in "${parts[@]}"; do
      [ -n "$joined" ] && joined+=" $__atelier_thin "
      joined+=$part
    done
    __atelier_seg 0 15 "$joined"
  fi

  __atelier_git
  printf '\033]633;P;GitBranch=%s\007' "$__atelier_br" # shown in Atelier's sidebar
  if [ -n "$__atelier_br" ]; then
    if [ -z "$__atelier_dirty" ]; then __atelier_seg 2 0 "$__atelier_branch $__atelier_br"
    else __atelier_seg 3 0 "$__atelier_branch $__atelier_br *"; fi
  fi

  [ "$ec" != 0 ] && __atelier_seg 1 15 "$__atelier_cross $ec"
  [ -n "$elapsed" ] && [ "$elapsed" -ge 2 ] && __atelier_seg 5 0 "$__atelier_clock ${elapsed}s"
  if [ "$EUID" = 0 ]; then __atelier_seg 8 15 "#"; else __atelier_seg 8 15 "\$"; fi

  __atelier_sgr "0;$((30 + __atelier_bg % 8 + (__atelier_bg > 7 ? 60 : 0)))"
  __atelier_ps+=$__atelier_arrow
  __atelier_sgr 0
  __atelier_ps+=$' \001\033]133;B\007\002'
  return $ec
}

if [ "${BASH_VERSINFO[0]}" -gt 4 ] || { [ "${BASH_VERSINFO[0]}" -eq 4 ] && [ "${BASH_VERSINFO[1]}" -ge 4 ]; }; then
  # PS0 is expanded before each command runs (in this shell, no subshell): start the timer, mark the command.
  PS0='${__atelier_none:$((__atelier_start=SECONDS, 0)):0}'$'\033]133;C\007'
fi
PROMPT_COMMAND="__atelier_prompt${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
if [ -n "$ATELIER_POWERLINE" ]; then PS1='${__atelier_ps}'
else PS1="$PS1"$'\001\033]133;B\007\002'; fi # the user's own prompt, with the end-of-prompt mark

# `claude` inside Atelier talks to the sessions of this project only (see the Atelier hub).
if [ -n "$ATELIER_CLAUDE_SETTINGS" ]; then
  claude() {
    case "$1" in
      mcp | config | update | doctor | install | plugin | setup-token | migrate-installer | -v | --version | -h | --help)
        command claude "$@" ;;
      *) command claude --settings "$ATELIER_CLAUDE_SETTINGS" --mcp-config "$ATELIER_CLAUDE_MCP" "$@" ;;
    esac
  }
fi

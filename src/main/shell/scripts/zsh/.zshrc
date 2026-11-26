# Atelier shell integration for zsh: the user's .zshrc first, then Atelier's prompt and markers.
# From here on zsh uses the user's own ZDOTDIR (a later .zlogin, `exec zsh`… behave as usual).
ZDOTDIR=${ATELIER_USER_ZDOTDIR:-$HOME}
[ -r "$ZDOTDIR/.zshrc" ] && . "$ZDOTDIR/.zshrc"
unset __atelier_zdotdir ATELIER_USER_ZDOTDIR
if [ "$ZDOTDIR" = "$HOME" ]; then unset ZDOTDIR; fi

if [ -n "$ATELIER_CWD" ]; then builtin cd -- "$ATELIER_CWD" 2>/dev/null; unset ATELIER_CWD; fi

typeset -g __atelier_arrow=$'\ue0b0' __atelier_thin=$'\ue0b1' __atelier_branch=$'\ue0a0'
typeset -g __atelier_cross=$'\u2718' __atelier_clock=$'\uf017' __atelier_more=$'\u2026'
typeset -g __atelier_start= __atelier_ran= __atelier_ps= __atelier_bg=
typeset -g __atelier_host=${HOST%%.*}
VIRTUAL_ENV_DISABLE_PROMPT=1

__atelier_urlencode() {
  emulate -L zsh
  local LC_ALL=C s=$1 c out=
  local -i i
  for (( i = 1; i <= ${#s}; i++ )); do
    c=$s[i]
    case $c in [A-Za-z0-9/._~-]) out+=$c ;; *) out+=$(printf '%%%02X' "'$c") ;; esac
  done
  REPLY=$out
}

__atelier_seg() { # bg fg text
  local -i b=$1 f=$2
  local bg=$((40 + b % 8 + (b > 7 ? 60 : 0))) fg=$((30 + f % 8 + (f > 7 ? 60 : 0)))
  if [[ -n $__atelier_bg ]]; then
    local -i p=$__atelier_bg
    __atelier_ps+="%{"$'\e'"[$((30 + p % 8 + (p > 7 ? 60 : 0)));${bg}m%}$__atelier_arrow"
  fi
  __atelier_ps+="%{"$'\e'"[${fg};${bg}m%} ${3//\%/%%} "
  __atelier_bg=$b
}

__atelier_preexec() {
  __atelier_start=$SECONDS
  __atelier_ran=1
  printf '\e]133;C\a'
}

__atelier_precmd() {
  local ec=$? elapsed=
  [[ -n $__atelier_start ]] && elapsed=$((SECONDS - __atelier_start))
  __atelier_start=
  __atelier_urlencode "$PWD"
  if [[ -n $__atelier_ran ]]; then printf '\e]133;D;%s\a' "$ec"; else ec=0; fi
  __atelier_ran=
  printf '\e]7;file://%s%s\a\e]133;A\a' "$__atelier_host" "$REPLY"
  [[ -z $ATELIER_POWERLINE ]] && return

  __atelier_ps= __atelier_bg=
  if (( EUID == 0 )); then __atelier_seg 1 15 "$USER"; else __atelier_seg 8 15 "$USER"; fi
  __atelier_seg 0 7 "$__atelier_host"
  [[ -n $VIRTUAL_ENV ]] && __atelier_seg 6 0 "${VIRTUAL_ENV:t}"

  local rest=
  if [[ $PWD == $HOME ]]; then __atelier_seg 4 0 "~"
  elif [[ -n $HOME && $PWD == $HOME/* ]]; then __atelier_seg 4 0 "~"; rest=${PWD#$HOME/}
  else __atelier_seg 4 0 "/"; rest=${PWD#/}
  fi
  if [[ -n $rest ]]; then
    local -a parts=("${(@s:/:)rest}")
    (( ${#parts} > 3 )) && parts=("$__atelier_more" "${(@)parts[-2,-1]}")
    __atelier_seg 0 15 "${(pj: $__atelier_thin :)parts}"
  fi

  if (( $+commands[git] )); then
    local st line br= oid= dirty=
    if st=$(git --no-optional-locks status --porcelain=v2 --branch --untracked-files=no 2>/dev/null); then
      for line in "${(@f)st}"; do
        case $line in
          '# branch.head '*) br=${line#'# branch.head '} ;;
          '# branch.oid '*) oid=${line#'# branch.oid '} ;;
          '#'*) ;;
          ?*) dirty=1 ;;
        esac
      done
      [[ $br == '(detached)' ]] && br=${oid[1,7]}
      if [[ -n $br ]]; then
        if [[ -z $dirty ]]; then __atelier_seg 2 0 "$__atelier_branch $br"; else __atelier_seg 3 0 "$__atelier_branch $br *"; fi
      fi
    fi
    printf '\e]633;P;GitBranch=%s\a' "$br" # shown in Atelier's sidebar
  fi

  (( ec != 0 )) && __atelier_seg 1 15 "$__atelier_cross $ec"
  [[ -n $elapsed ]] && (( elapsed >= 2 )) && __atelier_seg 5 0 "$__atelier_clock ${elapsed}s"
  if (( EUID == 0 )); then __atelier_seg 8 15 "#"; else __atelier_seg 8 15 "\$"; fi
  local -i l=$__atelier_bg
  __atelier_ps+="%{"$'\e'"[0;$((30 + l % 8 + (l > 7 ? 60 : 0)))m%}$__atelier_arrow%{"$'\e'"[0m%} %{"$'\e'"]133;B"$'\a'"%}"
  # Expanded at display time and never re-scanned for $(...) (prompt_subst expands one level): a folder or branch
  # named $(...) is shown, not run. Re-set every time in case a theme's precmd replaced it.
  PROMPT='$__atelier_ps'
}

autoload -Uz add-zsh-hook
add-zsh-hook preexec __atelier_preexec
add-zsh-hook precmd __atelier_precmd
if [[ -n $ATELIER_POWERLINE ]]; then
  setopt prompt_subst
else
  PROMPT+="%{"$'\e]133;B\a'"%}" # the user's own prompt, with the end-of-prompt mark
fi

# --mcp-config takes several values: --settings after it ends that list, so a prompt or a subcommand (attach) isn't
# read as one more config file.
if [[ -n $ATELIER_CLAUDE_SETTINGS ]]; then
  claude() {
    case "$1" in
      mcp | config | update | doctor | install | plugin | setup-token | migrate-installer | -v | --version | -h | --help)
        command claude "$@" ;;
      *) command claude --mcp-config "$ATELIER_CLAUDE_MCP" --settings "$ATELIER_CLAUDE_SETTINGS" "$@" ;;
    esac
  }
fi

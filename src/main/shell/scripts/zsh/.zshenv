# Atelier: zsh reads its startup files from here (ZDOTDIR); each one loads the user's own first.
__atelier_zdotdir=$ZDOTDIR
ZDOTDIR=${ATELIER_USER_ZDOTDIR:-$HOME}
[ -r "$ZDOTDIR/.zshenv" ] && . "$ZDOTDIR/.zshenv"
ATELIER_USER_ZDOTDIR=$ZDOTDIR # the user's .zshenv may move ZDOTDIR (e.g. ~/.config/zsh)
ZDOTDIR=$__atelier_zdotdir

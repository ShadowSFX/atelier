# Atelier: login shells read the user's .zprofile.
ZDOTDIR=${ATELIER_USER_ZDOTDIR:-$HOME}
[ -r "$ZDOTDIR/.zprofile" ] && . "$ZDOTDIR/.zprofile"
ZDOTDIR=$__atelier_zdotdir

#!/bin/sh

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
"$SCRIPT_DIR/start.sh" "$@"
STATUS=$?

case "$STATUS" in
    0|130|143)
        exit 0
        ;;
esac

if [ -t 0 ]; then
    echo
    echo "Startup stopped with an error. Review the message above."
    printf "Press Return to close this window..."
    read -r _
fi

exit "$STATUS"

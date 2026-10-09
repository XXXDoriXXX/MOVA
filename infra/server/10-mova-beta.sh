#!/bin/sh
set -eu
if [ "${MOVA_MOBILE_WEB_ENABLED:-false}" = true ]; then
    cp /etc/nginx/mova-beta.conf /etc/nginx/conf.d/default.conf
fi

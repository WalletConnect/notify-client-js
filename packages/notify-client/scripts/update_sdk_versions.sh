#!/bin/sh

notify_ver=$(grep "version" package.json | head -n1 | awk -F'"' '{print $4;}')


version_line="export const NOTIFY_SDK_VERSION = "\"$notify_ver\"";"

echo "$version_line" > src/constants/sdk_version.ts

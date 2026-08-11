/**
 * Single source of truth for the gk CLI version.
 *
 * The release workflow rewrites this file from the version tag before
 * compiling the standalone binary, so a shipped `gk` reports the tag it was
 * built from (e.g. `0.2.3`). The committed value is the current dev version.
 */
export const APP_VERSION = "0.2.0";

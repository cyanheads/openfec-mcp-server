/**
 * @fileoverview Election-cycle derivation shared by the itemized search tools.
 * Schedule A/B/E are large enough that an unscoped query times out upstream, so
 * the tools that page them fall back to the current cycle when none is given.
 * @module src/mcp-server/tools/definitions/utils/election-cycle
 */

/** Derive the current two-year election cycle (always even). */
export const currentCycle = (): number => {
  const year = new Date().getFullYear();
  return year % 2 === 0 ? year : year + 1;
};

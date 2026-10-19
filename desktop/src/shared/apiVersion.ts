/**
 * The ONE Salesforce API version this app speaks (S64 P6, 6.2).
 *
 * Every REST, Tooling, UI-API and Metadata call — including the composite
 * subrequest URLs that travel as payload bytes — derives its path from here, so
 * a version bump is a one-line change and the How To / Settings pages can state
 * the version the running build actually uses. `test/apiVersion.test.ts` fails
 * if a `/services/data/vNN.N` or bare `'NN.0'` literal reappears anywhere else
 * under `src/`.
 *
 * Dependency-free on purpose: imported by main, the pure engine and the renderer.
 */
export const API_VERSION = '66.0'

/** `API_VERSION` as a number — for Tooling `ApiVersion` fields and comparisons. */
export const API_VERSION_NUMBER = Number(API_VERSION)

/** REST data API root, e.g. `/services/data/v66.0`. */
export const DATA_API_PATH = `/services/data/v${API_VERSION}`

/** Tooling API root, e.g. `/services/data/v66.0/tooling`. */
export const TOOLING_API_PATH = `${DATA_API_PATH}/tooling`

/** Tooling SOQL endpoint prefix — append the URL-encoded query. */
export const TOOLING_QUERY_PATH = `${TOOLING_API_PATH}/query/?q=`

/** Tooling sObject root — append `<Type>/<Id>`. */
export const TOOLING_SOBJECTS_PATH = `${TOOLING_API_PATH}/sobjects/`

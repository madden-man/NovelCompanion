/**
 * A58 (PH-21): the build id file `scripts/build-id.ts` writes before the web
 * build. Typed here so a checkout that has not built yet still typechecks.
 */
declare module '*/generated/build-id.json' {
  const value: { id: string };
  export default value;
}

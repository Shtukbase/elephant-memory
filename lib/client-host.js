// The browser half's seat in the harness's plugin tree: no server code.
//
// The harness serves a package's browser bundle (`exports["./client"]`, built
// to lib/client.js) only for a package mounted as an entry of the PROFILE's
// own plugin list. The memory engine itself is mounted inside an agent preset
// (presets/endless.patch.yml), and entries inside a preset are not scanned for
// browser bundles (SEAMS.md, "The browser half"). So the patch also mounts
// this file at the top of the profile, by its path from the patch file
// (`../lib/client-host.js`); it only gives the package a place to be found.

export default {
  name: 'endless-client-host',
  inject: [],
  apply() {},
};
